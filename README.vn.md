# dsh-file-panel — panel xem file kiểu Antigravity cho DSH

Click vào file trong chat của **DSH Desktop / DeepSeek Harness** giờ **không mở app ngoài nữa**:
nó mở một **panel bên phải** ngay trong app — xem nội dung (có tô màu cú pháp), xem **diff** file
mà agent vừa sửa, cây thư mục workspace, và **sửa trực tiếp** rồi Save.

Toàn bộ nằm **ngoài bundle `.app`**: một plugin host + một client bundle cài vào profile `web`,
đúng chuẩn plugin DSH.

## Làm được gì

| Chỗ | Hành vi |
|---|---|
| Link file trong chat / tool card / deliverables | Mở panel trong app, không gọi `open <path>` |
| Tabs | Mỗi file một tab, theo session, đóng được (giữ 12 tab) |
| `Preview` | Có số dòng + highlight (`ReadBlock`), markdown render (`MarkdownText`), ảnh/PDF hiện trực tiếp qua route raw |
| `Changes` | Diff chuẩn IDE: header `@@ -a,b +c,d @@` có số dòng thật, gutter 2 bên tô màu, change bar, dòng trống có hatch, nhấn mạnh từng từ, gộp context dài, nhảy hunk, **inline** hoặc **side-by-side**, **revert từng hunk**, revert cả file, copy patch |
| `Review` | Mọi file agent đã sửa trong session, `+N −M`, mở rộng xem before/after, open/revert/patch từng file |
| `Files` | Cây lazy có badge thay đổi, **⌘P quick open**, **⌘⇧F tìm trong nội dung** (ripgrep bundled) |
| `Edit` | Sửa tại chỗ, `⌘S` lưu, ghi atomic, `409` nếu file đã đổi dưới chân |
| Làm việc theo dòng | Click (shift-click) 1 dòng → copy reference `path:line`, thêm review note |
| Notes | Note review theo session, copy ra để gửi lại cho agent |
| Tự refresh | Poll file đang mở; editor đang sửa dở thì báo *changed on disk* chứ không ghi đè; chấm xanh = trạng thái sống |
| Cửa sổ hẹp | Khi layout trả cột phải về 0 (cột giữa đòi 640px), panel **dock thành slide-over** dán vào mép phải, kéo resize được — thay vì render vô hình |
| Đóng panel | Cột thu lại, panel tool-details gốc trả về ghế của nó |

Phím tắt: `⌘S` lưu · `⌘F` tìm trong file · `⌘⇧F` tìm trong toàn workspace · `⌘P` quick open · `⌘W` đóng tab · `Esc` đóng palette → find → panel.

Panel chỉ **mượn ghế `details`** khi đang mở (`priority: -1000`), nên phần xem chi tiết tool call
không bị ảnh hưởng: click vào 1 tool call là panel tự nhường ghế.

## Ảnh chụp

Chụp thật từ rig (session tổng hợp, workspace fixture) — cắt đúng phần panel,
không lấy phần chat:

<p align="center">
  <img src="docs/screenshots/panel-preview.png" width="24%" alt="Surface Preview — file tô màu cú pháp, thanh path và dải tab">
  <img src="docs/screenshots/panel-changes.png" width="24%" alt="Surface Changes — diff của session: header hunk, change bar, nhấn mạnh từng từ, revert">
  <img src="docs/screenshots/panel-files.png" width="24%" alt="Surface Files — cây lazy có badge thay đổi, quick open, tìm nội dung bằng ripgrep">
  <img src="docs/screenshots/panel-review.png" width="24%" alt="Surface Review — các file agent đã sửa trong session kèm +N −M">
</p>

*Preview · Changes · Files · Review — panel dock ở cột phải của harness.*

## Cài đặt

Cần: DSH Desktop 0.8.x, Node 20+. Mở DSH Desktop một lần để nó tạo harness home.

**Một lệnh cho mọi máy** (macOS, Linux, Windows):

```sh
npx --yes github:thanhdz235123-commits/dsh-file-panel install
```

Rồi reload cửa sổ DSH — `Cmd-R` / `Ctrl-R`. Host half được patch watcher của profile nạp
ngay; client half cần reload.

Cài từ checkout, hoặc khi offline:

```sh
git clone https://github.com/thanhdz235123-commits/dsh-file-panel
cd dsh-file-panel
node bin/dsh-file-panel.mjs install
```

Trỏ tới harness home khác mặc định:

```sh
node bin/dsh-file-panel.mjs install --home "/path/to/harness" --profile web
```

### Hệ điều hành hỗ trợ

| OS | Harness home installer tự tìm |
|---|---|
| macOS | `~/Library/Application Support/dsh-desktop/harness` |
| Linux | `$XDG_CONFIG_HOME/dsh-desktop/harness`, không thì `~/.config/dsh-desktop/harness` |
| Windows | `%APPDATA%\dsh-desktop\harness` |

Toàn bộ là Node 20+ và API trình duyệt: path đi qua `node:path`, panel học separator
của host từ `/api/dsh-file-panel.health`, ripgrep bundled được resolve `rg` hoặc `rg.exe`.
`git` không bắt buộc — không có git thì tab `Changes` chỉ báo edit của session. Kiểm tra
máy bằng `doctor`:

```sh
npx --yes github:thanhdz235123-commits/dsh-file-panel doctor
```

### Installer làm gì

Hai dạng, không bao giờ chồng nhau — chọn một:

| Dạng | Lệnh | Cách kích hoạt |
|---|---|---|
| **copy** (mặc định) | `install` | copy file vào `<profile>/node_modules/dsh-file-panel`, chèn từ patch layer của profile. Không chạy package manager, không đụng lockfile. |
| **dependency** | `install --dep` | thêm `dsh-file-panel` vào `dependencies` + `dsh.profile.bundles` của `<profile>/package.json`; package manager của profile tự cài. Bundle mang theo patch layer nên **không** ghi row thủ công. |

```sh
node bin/dsh-file-panel.mjs status     # đang cài gì, ở đâu, build nào
node bin/dsh-file-panel.mjs doctor     # máy này có đủ điều kiện chạy không
node bin/dsh-file-panel.mjs uninstall  # xoá package, patch row và dependency
```

`--dep` mặc định cài từ `github:thanhdz235123-commits/dsh-file-panel`; dùng `--spec <spec>`
cho fork, tag (`github:you/dsh-file-panel#v0.3.4`) hoặc đường dẫn local
(`file:/path/to/checkout`). Mọi lệnh đều idempotent, và `uninstall` xoá đúng những gì
`install` đã ghi — patch layer rỗng được reset về `[]` để YAML vẫn hợp lệ.

## Route của host

Tất cả là exact Fetch route trên service `connection` ⇒ tự thừa hưởng auth của trình duyệt
(không cookie ⇒ `401`; `Origin`/`Host` lạ ⇒ `403`).

| Route | Việc |
|---|---|
| `GET /api/dsh-file-panel.file?path&cwd` | nội dung, ngôn ngữ, số dòng, size, mtime, sha256, cờ binary/truncated, thông tin git repo |
| `GET /api/dsh-file-panel.tree?path&cwd` | 1 cấp thư mục (dir trước, tối đa 4000 entry) |
| `GET /api/dsh-file-panel.changes?sessionId&cwd` | mọi file đã bị sửa trong session, kèm `+N −M` |
| `GET /api/dsh-file-panel.diff?path&cwd&sessionId&source` | hunk: `session` (`data.meta.diffs`), `git` (`git diff HEAD`), hoặc `none` |
| `GET /api/dsh-file-panel.stat?path&cwd` | size/mtime cho vòng poll |
| `POST /api/dsh-file-panel.write` | ghi atomic + chống ghi đè (stale guard) |
| `GET /api/dsh-file-panel.health` | kiểm tra service nào đang có |
| `GET /api/dsh-file-panel.probe?sessionId` | nguồn đọc session nào trả lời, được bao nhiêu event |

## Diff của session được đọc thế nào

Panel giữ **index diff sống theo từng session**, không quét lại log:

1. **Seed 1 lần cho mỗi session** — `ctx.sessionQuery.readSession(id)` (một pass
   đầy đủ của harness) và, với session nó từ chối/chưa ghi ra đĩa, đọc log
   `$DSH_HOME/sessions/<group>/<id>/session.jsonl.zstd` và giải **từng frame**.
   Log DSH là nhiều frame Zstandard nối nhau (mỗi append 1 frame); biên frame
   được tìm bằng cách đi theo header frame/block (magic cũng có trong dữ liệu
   nén) vì `zstdDecompressSync` của Node chỉ giải frame đầu. Seed từ log có trần
   (6000 frame mới nhất) và nhường event loop giữa batch nên không làm nghẽn harness.
2. **Tươi miễn phí sau đó** — `ctx.on('session/event', …)` fold mọi
   `tool/result` có `meta.diffs` vào index (khử trùng theo `seq`). Nhờ vậy đọc
   panel là O(1): đo trên session 4.5 MB / 208k event — lần đầu ~5s (pass của
   harness), mọi lần sau ~20ms, không đọc lại log kể cả sau vài phút.

Response có cờ `live` / `sessionLive` để biết nguồn. Không có hunk thì tab
`Changes` rơi về `git diff HEAD`; worktree sạch thì báo `none`.


## Restart

Client half được harness hot-reload (~0.5s sau khi lưu `client.js`). **Host half
(index.js) không hot-reload được trong app đã đóng gói** (HMR module cần internals
mà Electron host không có): sửa `index.js` thì cài lại + restart —
client half được harness hot-reload (~0.5 s). **Host half cần restart**: thoát hẳn DSH Desktop rồi mở lại.

## Giới hạn đã biết

- Cột phải chỉ render khi session hiện tại **không blank** (gate của chính layout). Không có session
  như vậy thì click vẫn mở file bằng app ngoài như cũ, chứ không "nuốt" cú click.
- Session log viết tay mà không đúng byte-exact có thể làm `sessionQuery.readSession` từ chối cả log;
  đường đọc từ đĩa bù được.
- File binary và file >1.5 MB chỉ được báo, không render.
- Nút `Open IDE` dùng lại đúng opener gốc — hành vi y như trước.

## Đối chiếu Antigravity

Panel bám theo các mặt "artifact/review" của Antigravity: cột review ngay trong app thay vì mở editor ngoài,
accept/reject theo từng chunk (ở đây là revert), cả hai chế độ diff inline **và** side-by-side, danh sách file
đã đổi, artifact markdown/ảnh, và code search ngay trong cột — xem
[Antigravity artifacts](https://antigravity.google/docs/artifacts) và
[hướng dẫn diff view](https://antigravitylab.net/en/articles/editor/antigravity-diff-view-advanced-guide).

## Changelog

- **0.3.8** — panel không bao giờ vô hình. Việc nó chiếm cột phải hay dock giờ **đo thật** (độ rộng thật của cột), không đoán theo bản sao công thức chia cột của DSH: ở vài cỡ cửa sổ cột phải resolve về 0px, panel vẫn mount ở đó thành dải 0px mà vẫn giữ ghế — nhìn y như UI hỏng. `ResizeObserver` đổi qua lại giữa cột và dock ngay khi layout đổi ý.
- **0.3.7** — không mở gì trừ khi nó có thật trên đĩa. Mọi đường vào (link chat, tool row, cây file, quick open, dòng review) đều `stat` trước: path không tồn tại bị từ chối kèm **đúng đường dẫn tuyệt đối đã thử** và **không tạo tab nào**, nên panel không bao giờ trông như đã mở một file không tồn tại. Link thư mục vẫn mở cây file. Host từ chối trả byte cho path thiếu (`404 not-found`) và từ chối mọi thứ không phải file thường.
- **0.3.6** — surface `Edit` thành editor kiểu IDE: gutter số dòng cuộn theo text và sáng dòng đang đứng, band dòng hiện tại, `Ln, Col`, Tab = 2 spaces, Enter giữ indent, `Cmd-S` lưu có sha-guard, `Revert edits`.
- **0.3.5** — link mở **đúng** path nó ghi. Cơ chế dò basename (và danh sách "chọn 1 trong các file giống tên") đã bị bỏ: link tới `<root>/index.js` mở đúng file đó hoặc báo không có, **không bao giờ** mở file cùng tên ở chỗ khác. Màn hình lỗi in ra đúng chuỗi link + đường dẫn tuyệt đối đã resolve, kèm nút `Search workspace` tự nguyện — không mở gì cho tới khi mày chọn. Route `resolve` phía host vẫn còn như API cho tooling; luồng link không còn gọi nó.
- **0.3.4** — một file = một tab, luôn luôn. Link trong chat được resolve **trước khi** tab tồn tại (nên cách viết sai không còn để lại tab rỗng nằm cạnh file thật), và mọi kết quả bất đồng bộ khớp với tab qua **id ổn định** thay vì so chuỗi đường dẫn. Thêm: thanh đường dẫn đầy đủ dưới tên file (bấm để copy), khối chi tiết file (path, relative, size, lines, modified, sha256, language, encoding, session +/-, nguồn link), tooltip đường dẫn tuyệt đối ở cây file, nút `Copy path` trong Review, banner `Opening <path>…` khi link đang resolve, tự nạp khi chọn tab chưa có nội dung, và event trace 120 dòng ở `window.__dshFilePanel.state(sessionId).events`. Bộ test: 36 check rig, 17 check live.
- **0.3.1** — làm lại renderer diff: hàng đã canh LCS với số dòng cũ/mới thật, màu theo theme IDE, change bar, hatch bên trống, gộp context, header 1 dòng có `⌖` nhảy hunk và `↺` revert, thêm gợi ý khi panel hẹp cho side-by-side.
- **0.3.0** — nhiều tab file, tab Review, revert từng hunk/cả file, side-by-side diff nhấn mạnh từng từ, quick open + tìm nội dung bằng ripgrep, preview markdown/ảnh, chọn dòng + notes; **sửa lỗi** panel rò file của session này sang cột của session khác (đổi session là nhả ghế).
- **0.2.1** — index diff sống theo session (seed 1 lần, sau đó `session/event`), đọc panel luôn O(1).
- **0.2.0** — đi biên frame zstd đúng, scan log có trần + nhường event loop, so path canonical, client không chặn.

## License

MIT
