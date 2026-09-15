# doc2pdf

Tiện ích Chromium xuất tài liệu đang xem trên **Studocu** và **Scribd** thành PDF, tải thẳng vào thanh Download của Chrome. Tiện ích cũng có tùy chọn bỏ giới hạn preview Scribd.

Chỉ lấy nội dung mà trang đã render cho bạn xem. Dùng cho học tập cá nhân; đừng tái phân phối tài liệu có bản quyền.

## Cài đặt

1. Tải/giải nén thư mục này (hoặc `doc2pdf.zip`).
2. Mở `chrome://extensions` trong Chrome, Edge hoặc Cốc Cốc.
3. Bật **Developer mode**.
4. Bấm **Load unpacked** và chọn thư mục `doc2pdf`.

## Xuất PDF

1. Mở một trang tài liệu Studocu hoặc Scribd. Panel nổi ở góc dưới phải có các ô **Từ trang**, **Đến trang**, chất lượng và nút **PDF**.
2. Chọn một khoảng trang liên tiếp. Để trống **Đến trang** để xuất đến trang cuối cùng đang có.
3. Chọn **Tự động**, **Cao**, **Cân bằng** hoặc **Nhẹ**. Tự động dùng Cao đến 40 trang, Cân bằng đến 100 trang, và Nhẹ khi nhiều hơn 100 trang.
4. Bấm **PDF**. Panel hiển thị tiến độ và ước tính dung lượng; PDF hoàn chỉnh sẽ xuất hiện trong thanh Download.

Nút **Hủy** dừng công việc mạng ngay. Nếu một lần chụp canvas đang chạy, tiện ích có thể đợi lần chụp đó xong rồi mới hủy hoàn toàn. Khi có lỗi hoặc bị hủy, tiện ích không tạo file HTML hay PDF một phần; hãy thử lại với khoảng trang nhỏ hơn hoặc chất lượng thấp hơn.

Panel tự xuất hiện khi điều hướng SPA vào một trang tài liệu và biến mất khi rời trang tài liệu.

## Unblur Scribd

Popup trên thanh công cụ của trình duyệt có công tắc bật/tắt xóa tự động cookie `sd_docs`. Công tắc này chỉ tác động các tên miền Scribd, không xóa cookie đăng nhập và không ảnh hưởng Studocu.

## Kiểm tra

- `node test.mjs` chạy bộ kiểm tra nhanh, không cần phụ thuộc.
- `node real-test.mjs` mở Chrome tạm thời và kiểm tra hai provider trực tiếp. Provider có thể yêu cầu xác minh con người; khi đó lệnh sẽ báo thất bại thay vì vượt qua xác minh.

## Cấu trúc

| File | Vai trò |
|---|---|
| `manifest.json` | Manifest V3, quyền và content scripts |
| `content.js` | Panel, trích xuất trang, chụp canvas và tải PDF |
| `background.js` | Fetch có kiểm soát và xóa cookie Scribd |
| `bridge.js` | Relay cô lập cho fetch đặc quyền |
| `lib.js` | Logic thuần cho trang, chất lượng, provider và PDF |
| `popup.html`, `popup.js` | Công tắc unblur Scribd |
| `test.mjs` | Kiểm tra nhanh |
| `real-test.mjs` | Kiểm tra Chrome/provider trực tiếp |

## Khi trang đổi cấu trúc mà tiện ích hỏng

Selector và pattern nằm trong `lib.js` (URL trang, JSONP) và đầu `content.js` (`__NEXT_DATA__` / `docManager`). Sửa đúng vị trí đó rồi chạy lại các kiểm tra ở trên.

## Smoke test trước khi phát hành

- Load unpacked và xác nhận popup lưu được công tắc unblur sau khi đóng/mở lại.
- Mở một tài liệu từ trang tìm kiếm bằng SPA; panel phải xuất hiện, rồi biến mất khi rời tài liệu.
- Xuất 2 trang ở Auto; PDF phải có đúng 2 trang và mở được.
- Bấm Hủy khi đang chụp; không được tải file một phần.
- Tắt unblur, tạo `sd_docs` và xác nhận cookie còn; bật lại và xác nhận cookie bị xóa.
- Thử một tài liệu cần bridge fallback và xác nhận vẫn tải được nội dung cùng provider.
