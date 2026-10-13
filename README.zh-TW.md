# omp-mcp-guard

給 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）用的 MCP 守門擴充套件，接上別人寫的 MCP 工具時用，一次 `-e` 全部載入：

- **呼叫守門員**：omp 把呼叫送到 MCP server 之前先判斷。擋下封鎖清單上的工具與 server、說明在你審過之後被改掉的工具、說明裡有注入句型的工具；無頭執行時可以改成「只放行清單上的工具」。
- **結果守門員**：依實際回應的 server 決定 MCP 結果要扣下還是加標示。從 Day27 文章的守門員移植，另外也檢查錯誤結果和只有圖片的結果。
- **指示過濾**：把各 server 在 `initialize` 回的指示，從 omp 18.2.8 的系統提示詞拿掉。
- 一份共用的紀錄，加上 `mcp-guard` 指令：審查並鎖定工具說明、彙總每個 session、在打開不信任的 repo 之前先稽核設定。

[English](README.md)

> **沒有用真模型測過。** live 測試用腳本模型驅動真的 omp（18.2.8，以及 18.10.3），連本機的 MCP server，從頭跑到尾。它證明哪些東西被擋、被扣下、被加標示、被拿掉；不證明真模型看到這些之後會怎麼做。

## 為什麼

同事丟來一個附了 MCP 設定的 repo，你用 omp 的無頭模式跑，沒有人看著畫面。Day27 文章在 omp 18.2.8 上量到：

- repo 附的 `.cursor/mcp.json` 會在第一次模型請求之前就啟動裡面的指令，除非 overlay 設了 `mcp.enableProjectConfig: false`；而且 repo 自己的 `.omp/config.yml` 排在你的全域設定之上。
- omp 把每個 MCP 工具都當成 `write`，預設模式直接放行；無頭執行沒有人能按 `always-ask` 的核准。
- 工具說明和 server 指示原文送進模型（指示放在系統提示詞裡）；server 送出 `tools/list_changed`，omp 就重新綁定新的說明，不再問一次。
- 兩台 server 的名稱轉換後相同，就會產生同一個工具名稱；omp 默默留一個，撞名只寫進行程紀錄檔。
- 文章的結果守門員在 server 跑完之後才動作，而且錯誤結果原樣放行。

Day27 的整合時序圖把文章的強化、upstream omp、掃描器與稽核做法接成一條線。這個套件是其中在 omp 行程裡跑的部分，加上前後的檢查。

## 做什麼

| 部分 | 時機 | 做什麼 |
|---|---|---|
| 呼叫守門員 | `mcp__` 工具、`write xd://mcp__…`（模型呼叫 MCP 裝置的方式）、`read xd://mcp__…`（讀完整說明）的 `tool_call` | 在 server 執行之前擋下，第一條成立就停：設定檔不能用；鎖定檔讀不到；omp 最後生效的 `mcp.enableProjectConfig` 不是 `false`；在 `blockedTools`；符合 `blockedServers` 的工具名稱前綴；行程紀錄檔說撞過名；omp 沒有列出這個名稱；說明或 schema 和鎖定時不同；說明或 schema 有注入句型；`unpinned` 是 `block` 時沒有鎖定；`callPolicy` 是 `allowlist` 時不在 `allowTools`。讀完整說明只在說明相關與封鎖清單的理由下擋。 |
| 說明快照 | `session_start`，之後每一輪與每次 MCP 呼叫 | 對每個 MCP 工具的名稱、說明、參數 schema 算雜湊，和你的鎖定比對，寫一份快照給 `mcp-guard review` 用，並記下設定檔與鎖定檔的雜湊。omp 18.2.8 啟動時只等 MCP server 250 毫秒，晚連上的 server，它的工具出現時再補進來。 |
| 結果守門員 | `mcp__` 工具的 `tool_result` | 只看 `details.serverName`：沒有 server 名稱或在封鎖清單，扣下；任何 server 命中注入句型，扣下；可信的 server，原樣放行；其他的加上 `[UNTRUSTED MCP RESULT from MCP server …]`。錯誤結果和只有圖片的結果也一樣判。扣下時細節欄位一起換掉，session 紀錄裡沒有原文。 |
| 指示過濾 | `before_agent_start` | 每次請求都把系統提示詞裡的〈MCP Server Instructions〉一節拿掉。工具照用。 |
| 行程紀錄檔 | `session_start` 與每次 MCP 呼叫 | 讀這個行程自己的 `omp.<日期>.<pid>.log`：撞名（之後擋下）和連不上的 server 寫進紀錄並發通知。 |
| 通知 | `session_start` | 每個部分涵蓋什麼、各狀態的工具數、每個被封鎖的 server 前綴擋到哪些工具，以及每個讓守門員改成全擋的錯誤。 |
| `mcp-guard` | 執行前後 | `review`、`pin`、`report`、`audit`，見下面。 |

設定裡 `tools.approval` 的 deny 仍然最先生效：被 deny 的呼叫，omp 在任何擴充看到之前就擋下了。

## 需求

- omp 18.2.8（完整測過）。omp 18.10.3 測過原生 `instructions: false` 與守門員並用、裝置呼叫、讀取最後生效的專案設定。
- [Bun](https://bun.sh) 1.3.14 以上（用 1.4.2 測）。

## 安裝與執行

clone 到**所有** agent 會碰的專案之外，agent 才改不到守門員。執行時不需要任何相依套件；`bun install` 是給測試用的。

```bash
git clone <this repository> ~/omp-mcp-guard
cd ~/omp-mcp-guard && bun install
```

自己的 `~/.omp/agent/mcp.json` 只列用得到的 server（見 `examples/mcp.json`），把 `examples/overlay.yml` 複製到要打開的 repo 之外，然後：

```bash
omp -p --mode json --cwd <不信任的 repo> --no-extensions -e ~/omp-mcp-guard \
  --config ~/omp-overlay.yml "<提示詞>" > events.jsonl
```

- `-e ~/omp-mcp-guard` 照套件裡的順序載入三支擴充。
- `--config` 帶入 overlay。omp 的優先序是 全域 ＜ 專案 ＜ `--config` ＜ 旗標，所以 repo 打不開專案層的 MCP。沒帶的話，呼叫守門員會擋下所有 MCP 呼叫並說明原因；但這時專案的 server 已經啟動了。
- `--no-extensions` 關掉自動發現的擴充，但擋不住專案根目錄的 `.mcp.json`（upstream #14182），所以 overlay 仍然要帶。hol-guard 的受管擴充 `~/.omp/agent/extensions/hol-guard.ts` 也會一起被關掉，要另外用 `-e` 帶進來；兩者一起用，沒測。
- `--mode json` 的輸出要存下來：被 `tools.approval` deny 擋下的呼叫只記在這裡。

subagent 會拿到同樣的 `-e` 擴充（Day22 實測），委派出去的 MCP 呼叫也會被檢查。

### 審查與鎖定工具說明

1. 載入守門員跑一次 omp。沒有鎖定的工具照樣放行，記成「新的」（設了 `unpinned: "block"` 就擋下）。
2. `bun ~/omp-mcp-guard/bin/mcp-guard.ts review` 印出那個 session 看到的東西：每個工具的狀態、雜湊、命中的注入句型，以及框起來的說明和 schema（server 寫的文字；跳脫序列和控制字元已拿掉）。
3. `mcp-guard pin <工具>...` 鎖定你接受的工具。`--all-new` 鎖定所有沒有命中句型的新工具，已變更或被標記的會跳過，要點名才鎖。

之後只要已鎖定工具的說明或 schema 改了，就會被擋，直到你重新審查、重新鎖定；server 在 session 中途改的也一樣。

## 設定

可選，放在 `~/.config/omp-mcp-guard/config.json`，omp 載入守門員時讀一次。不從環境變數讀任何東西：Bun 會把專案的 `.env` 載入 omp 的環境，否則 repo 可以把自己的 server 寫成可信。見 `examples/config.example.json`。

| 設定 | 預設 | 意思 |
|---|---|---|
| `trustedServers` | `[]` | 完整的 server 名稱（MCP 設定的鍵），結果不加標示。 |
| `blockedServers` | `[]` | 完整的 server 名稱。呼叫依工具名稱前綴擋（`docs` 是 `mcp__docs_`，也是 `docs-b` 那台工具的開頭）；結果扣下。同一個名稱不能同時可信又封鎖。 |
| `blockedTools` | `[]` | 完整的 `mcp__` 名稱，一律擋。 |
| `callPolicy` | `"open"` | `"allowlist"`：只放行 `allowTools`。 |
| `allowTools` | `[]` | 放行清單上完整的 `mcp__` 名稱。 |
| `unpinned` | `"allow"` | `"block"`：沒有鎖定的工具擋下。無頭執行時用。 |
| `requireProjectMcpOff` | `true` | omp 最後生效的 `mcp.enableProjectConfig` 不是 `false` 或讀不到時，擋下所有 MCP 呼叫。 |
| `serverInstructions` | `"drop"` | `"keep"` 保留指示那一節。 |
| `blockCollided` | `true` | 擋下行程紀錄檔說撞過名的工具。 |
| `ledger` | `~/.omp/mcp-guard-ledger.jsonl` | 絕對路徑或 `~/` 開頭。 |
| `pins` | `~/.config/omp-mcp-guard/pins.json` | 由 `mcp-guard pin` 寫入。 |
| `snapshot` | `~/.omp/mcp-guard-seen.json` | 每次 session 開始時寫入，存著要審查的說明。 |
| `logDir` | `~/.omp/logs` | omp 行程紀錄檔的資料夾；`$XDG_STATE_HOME/omp/logs` 存在時用它，和 omp 一樣。 |

設定檔不能用時，session 開始會發通知；這時呼叫守門員擋下所有 MCP 呼叫，結果守門員扣下所有 MCP 結果，指示過濾照樣拿掉那一節。

規則用工具名稱，因為呼叫之前 omp 只列出名稱；這也是 omp 自己 `tools.approval` 用的鍵。撞名之後，名稱規則和鎖定都會套到 omp 留下的那台，所以撞過名的工具一律擋。

## 紀錄

每行一個 JSON，帶 `ts`、`event`、`session`。名稱只留名稱字元；工具參數與結果原文一律不寫。

| `event` | 誰寫 | 欄位 |
|---|---|---|
| `session` | 呼叫守門員 | `tools`、`config` 與 `pins`（SHA-256 前 12 碼）、`projectMcp`（`off`/`on`/`unknown`）、`callPolicy`、`unpinned`、`configError`、`pinsError` |
| `inventory` | 呼叫守門員 | `tool`、`state`（`pinned`/`new`/`changed`）、`pattern`、`sha256` |
| `call` | 呼叫守門員 | `call`、`tool`、`via`（`direct`/`xd`/`docs`）、`decision`（`allow`/`block`）、`reason`、`server`、`state`、`pattern` |
| `list-changed` | 呼叫守門員 | `server` |
| `collision` / `load-failed` | 呼叫守門員 | `tool`、`keptServer`、`ignoredServer` / `server` |
| `decision` | 結果守門員 | `call`、`server`、`tool`、`provider`、`isError`、`decision`（`pass`/`label`/`withhold`）、`reason`、`pattern`、`chars`、`images` |
| `instructions` | 指示過濾 | `decision`、`chars`、`servers`（找到的 `### ` 標題，server 可以偽造）、`userAppendDropped` |

## `mcp-guard` 指令

用 `bun ~/omp-mcp-guard/bin/mcp-guard.ts <指令>` 執行。它不連 MCP server，也不呼叫模型。`--config`、`--snapshot`、`--pins`、`--ledger` 可以改路徑。

| 指令 | 做什麼 |
|---|---|
| `review [--json]` | 最近一份快照，對照目前的鎖定。 |
| `pin <工具>... \| --all-new` | 從快照鎖定；快照裡沒有的名稱一律拒絕。 |
| `report [--session <id>] [--json]` | 每個 session：說明狀態、放行與擋下的呼叫（附理由）、放行／加標示／扣下的結果、拿掉指示的次數、`list_changed` 通知、撞名、連不上。 |
| `audit --repo <dir> --overlay <file> [--mcp <file>]... [--omp <command>] [--json]` | 打開 repo 之前：在那個目錄帶 overlay（`PI_CONFIG_FILES`）問 omp `mcp.enableProjectConfig`，要是 `false`；確認 overlay 是巢狀寫法；確認你的 `mcp.json` 裡沒有兩個 server 名稱共用工具名稱前綴；確認封鎖的 server 前綴沒有蓋到可信的 server；列出 overlay 讓 omp 不載入的專案 MCP 檔，以及想打開它的專案設定。有一項不過就 exit 1。 |

## 範例

- `examples/overlay.yml`：巢狀的 `mcp.enableProjectConfig: false`；`bash`、`eval` 設 deny；依名稱 deny 一個 MCP 工具。測試裡用 omp 自己的設定載入器讀它。
- `examples/mcp.json`：使用者層的 server，帶 `instructions: false`（omp 18.3.1 起才認）和 `disabledServers`。
- `examples/config.example.json`：每個設定項。

掃描器不在這個套件裡。打開 repo 之前，在沙箱裡用 [snyk/agent-scan](https://github.com/snyk/agent-scan)（`--ci`）或 [cisco-ai-defense/mcp-scanner](https://github.com/cisco-ai-defense/mcp-scanner)（`--analyzers yara`）掃它的 MCP 設定：兩者都會執行 server 的指令或連它的網址，才拿得到工具清單。

## 測試

```bash
bun run test
```

`bun run test` 會用暫時的 `HOME` 和 `TMPDIR` 啟動 Bun；直接 `bun test` 會拒絕執行，因為測試會在家目錄下寫紀錄、鎖定檔和 omp 的狀態。單元測試經過 omp 自己的擴充載入器與 runner，不需要網路；`audit` 的測試會執行 omp 自己的 `config get`。

live 測試用只供測試的腳本模型（`test/scripted-provider.ts`）驅動真的 omp，每次執行都有自己的暫時家目錄。使用者層的 MCP server 在測試行程裡以本機 HTTP 提供（`test/mcp-http.ts`），才能在 omp 啟動時那 250 毫秒內連上；在 omp 18.2.8 的無頭執行裡，晚連上的 server 始終沒有變成模型叫得到的裝置。repo 自己的 server 是 stdio 指令（`test/mcp-server.ts`），因為那裡要看的是 omp 會不會啟動它。執行方式：

```bash
MCP_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
MCP_GUARD_LIVE_OUT=/tmp/mcp-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` 改跑已安裝的 omp。在 omp 18.2.8 上：沒有守門員時，server 的指示在系統提示詞裡、帶注入的結果送到模型、說明被下毒的工具照樣執行，不帶 overlay 時 repo 的 server 會啟動。有守門員時：被封鎖 server 的工具和被下毒的工具經由 `xd://` 被擋，它們的 server 收到 0 次呼叫；讀被下毒工具的完整說明也被擋；`tools.approval` 的 deny 仍然最先擋下；沒有任何一次請求帶著指示；帶注入的結果和帶注入的錯誤都被扣下，session 紀錄裡兩者都沒有；不明 server 的結果加了標示；兩次執行之間被改的說明、沒有鎖定的工具、session 中途被改的說明都被擋；放行清單有效；不帶 overlay 時所有呼叫被擋；撞名從 omp 的行程紀錄檔讀到並被擋。在 omp 18.10.3 上：原生 `instructions: false` 加上過濾，請求裡沒有任何指示；裝置呼叫在 server 前後都被檢查；帶與不帶 overlay 時都讀得到最後生效的專案設定。

## 公開發布前要做的

- **安全稽核。** 沒跑。實作前做了威脅模型（OWASP LLM Top 10 加 OWASP Agentic，共 20 類），但沒有針對程式碼做獨立的對抗式審查。
- **真模型測試。** 沒跑。
- **hol-guard 與掃描器。** 沒有和這個套件一起跑過。
- **第一次 CI。** GitHub Actions 還沒跑過；`bun.lock` 是離線產生的。
- **其他 omp 版本。** 只測過 18.2.8 和 18.10.3。指示過濾、行程紀錄檔的讀法、設定的讀法，都依這兩版的文字與 API。

## 限制

- **放行的呼叫照樣在 server 上執行。** 守門員決定呼叫會不會發生、事後模型看到什麼；追不回 server 那端做了什麼，也不檢查參數。
- **說明仍然送進模型。** MCP 工具以 `xd://` 裝置掛載時（omp 預設），系統提示詞帶的是縮短的說明，`read xd://<工具>` 回傳完整的；關掉裝置時，模型供應商的工具清單帶著完整說明。守門員擋的是對被標記或已變更工具的呼叫與完整說明的讀取，不改寫模型看到的內容。
- **鎖定的是說明，不是行為。** server 可以不改說明就改工具做的事；第一次鎖定的說明會被當成已審過。
- **呼叫可能和重新綁定搶時間。** 收到 `tools/list_changed` 之後、omp 還沒綁好之前的呼叫，比對的是舊的說明。
- **封鎖 server 是看前綴。** 封鎖 `docs` 也會擋到叫 `docs-b` 的 server；session 通知和 `audit` 會列出重疊。
- **關鍵字句型只是絆線。** 換個說法的內容只會加標示；只是引用某句話的結果會整段被扣下。標示是建議，模型可以不理。
- **指示是整節拿掉。** 在 omp 18.2.8 上，排在後面的使用者 `--append-system-prompt` 也會一起拿掉（紀錄會寫明）；18.3.1 起，逐台的 `instructions: false` 比較細。
- **慢的 server 可能整個不見。** omp 18.2.8 啟動時只等 MCP server 250 毫秒；在無頭的測試執行裡，晚連上的 server 在那個 session 始終沒有變成 `xd://` 裝置。守門員會在工具出現時記下來，但沒辦法讓 omp 掛載它。
- **專案的 MCP server 在任何擴充執行前就啟動。** 守門員只能事後擋它的呼叫；讓它不啟動的是 overlay。
- **agent 改得到守門員的檔案。** 設定與鎖定每次 omp 啟動讀一次，雜湊寫進紀錄；但被劫持的 agent 只要有寫入工具，就能改掉下一次要用的檔案。放在所有專案之外，最好設成唯讀。紀錄本身不防竄改。
- **依版本的讀法。** 撞名的讀法依 omp 的紀錄文字，過濾依它的標題文字，設定讀取依它的設定物件；設定讀不到時，所有呼叫都擋。

## 背景

這個套件實作 Day27 整合時序圖（接上別人寫的 MCP 工具）在 omp 這一側的部分：④ 的專案 MCP 檢查與指示過濾、⑤ 的呼叫前檢查、⑥ 的結果守門員、⑦ 的紀錄、彙總與行程紀錄檔，以及 ③ 的稽核；說明鎖定補上圖裡寫著「做得到，但沒寫」的那一項。注入句型是 Day25 文章的那幾種，加上 Invariant Labs 公開的 MCP tool poisoning 寫法。upstream 的相關背景：巢狀 overlay（[#14259](https://github.com/can1357/oh-my-pi/pull/14259)）、為什麼只有 `--config` 壓得過專案（[#13330](https://github.com/can1357/oh-my-pi/issues/13330)）、`--no-extensions` 與 `.mcp.json`（[#14182](https://github.com/can1357/oh-my-pi/issues/14182)）、逐台的 `instructions: false`（v18.3.1，[#13196](https://github.com/can1357/oh-my-pi/pull/13196)）。[hashgraph-online/hol-guard](https://github.com/hashgraph-online/hol-guard) 以受管擴充的形式佔了類似的 `tool_call` 位置。

## 授權

[MIT](LICENSE)
