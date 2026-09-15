# doc2pdf

Extension Chromium (Manifest V3) xuất tài liệu đang xem trên **Studocu** và **Scribd** ra PDF, tải thẳng vào thanh Download của Chrome. Kèm xoá cookie đếm lượt xem preview (unblur).

Chỉ lấy được nội dung mà trang render cho bạn xem. Dùng cho học tập cá nhân, đừng tái phân phối tài liệu có bản quyền.

## Cài đặt

1. Tải/giải nén thư mục này (hoặc file `doc2pdf.zip`).
2. Mở `chrome://extensions` (Chrome, Edge, Cốc Cốc đều dùng được đường dẫn tương tự).
3. Bật **Developer mode** (góc trên phải).
4. Bấm **Load unpacked** → chọn thư mục này (`scribd` / `doc2pdf`).

## Dùng

- Mở trang tài liệu Studocu/Scribd → bấm nút xanh **↓ PDF** ở góc dưới phải.
- Đợi chụp từng trang — file rơi vào thanh Download (`Downloads`, tên theo title tài liệu).
- Nếu Scribd chặn canvas (ảnh cross-origin) thì tải file `.html` cùng chỗ đó.
- Nút hiện trạng thái: đang lấy trang nào, lỗi (hover để xem chi tiết).

## Cấu trúc

| File | Vai trò |
|---|---|
| `manifest.json` | MV3, khai báo quyền + trang chạy content script |
| `content.js` | Nút ↓ PDF, đọc dữ liệu trang, chụp canvas, tải PDF |
| `background.js` | Xoá cookie `sd_docs` (unblur) |
| `lib.js` | Logic thuần: parse JSONP, URL trang có chữ ký, đổi host ảnh, ghép PDF |
| `test.mjs` | Self-check: `node test.mjs` |
| `real-test.mjs` | Chrome CDP lên Scribd thật: `node real-test.mjs` |

## Khi trang đổi cấu trúc mà extension hỏng

Toàn bộ selector/pattern nằm trong `lib.js` (URL trang, JSONP) và đầu `content.js` (đọc `__NEXT_DATA__` / `docManager`). Sửa đúng chỗ đó là lại chạy.

## Unblur

`background.js` xoá ngay lập tức cookie có tên đúng `sd_docs` mỗi khi được ghi — đây là cookie đếm lượt xem preview, **không đụng cookie đăng nhập**. Không xoá bất kỳ cookie nào khác.
