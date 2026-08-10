# TTVH Tuyển Dụng — Thịnh Thế Vinh Hoa F&B Group

Landing page tuyển dụng + bảng dữ liệu + Kanban phân loại ứng viên, kết nối API 1Office.

## Thành phần
- `index.html` — Landing page tuyển dụng + form ứng tuyển (đẩy hồ sơ vào 1Office).
- `tuyen-dung.html` — Bảng dữ liệu ứng viên/đề xuất/chiến dịch/kênh từ 1Office.
- `kanban.html` — Kanban phân loại hồ sơ ứng viên theo giai đoạn (mới cập nhật lên đầu, tự báo dữ liệu mới).
- `server.js` — Proxy Node (chỉ dùng module built-in, **không cần `npm install`**) giữ token an toàn, tránh CORS, và nhận form ứng tuyển.
- `config.example.json` — Mẫu cấu hình. **`config.json` thật (chứa token) không được đưa lên git.**
- `images/` — Logo các thương hiệu (MayCha, Tam Hảo, Gà Giòn Ba Cô Gái, Trà Hú) + ảnh.

## Màn hình "Đăng ký lịch đào tạo" (admin)
- **Trạng thái hồ sơ**: Mới đăng ký → Chờ xác nhận → Đã xác nhận → Đã gửi thông tin đào tạo → Đã tham gia; kèm Vắng mặt / Xin đổi lịch / Hủy. Ứng viên tự đổi lịch qua chatbot sẽ tự chuyển sang *Xin đổi lịch*.
- **Bộ lọc nâng cao** (ngày đăng ký, ngày đào tạo, tỉnh/huyện, vị trí, Full-time/Part-time, Online/Trực tiếp, cửa hàng, trạng thái) + chip hiển thị điều kiện đang lọc.
- **Thao tác hàng loạt**: đổi trạng thái, đổi lịch, gửi email, xuất Excel, xóa.
- **Xóa mềm**: hồ sơ xóa đi vào *thùng rác* (Bộ lọc → Xem thùng rác) và khôi phục lại được; chỉ "Xóa vĩnh viễn" mới gỡ khỏi DB.
- **Lịch sử thao tác** ghi rõ người thực hiện, thời điểm và nội dung thay đổi — xem chung ở tab *Lịch sử chỉnh sửa* hoặc riêng từng hồ sơ ở nút **Xem**.

## Chatbot — kịch bản & trợ lý AI
Thứ tự trả lời: **kịch bản có sẵn → trợ lý AI → câu trả lời mặc định**.
- **Kịch bản** (tab *Kịch bản chatbot*): khớp từ khóa → trả lời mẫu, luôn được ưu tiên.
- **Trợ lý AI (Gemini)** — mặc định TẮT, bật trong cùng tab. AI chỉ được dùng thông tin trong kịch bản (+ ô "Thông tin bổ sung được duyệt"), **không được bịa** lương/chế độ/địa chỉ/link. Khi AI không đủ thông tin chắc chắn, nó trả về mã `KHONG_RO` và hệ thống tự chuyển sang câu mặc định.
- **Câu trả lời mặc định**: dùng khi không khớp kịch bản và AI không trả lời chắc chắn (hoặc AI đang tắt / sai key / quá thời gian).
- API key đặt trong dashboard (lưu ở DB, không bao giờ gửi lại về trình duyệt) hoặc qua env `GEMINI_API_KEY`. Nút **Thử** cho biết câu hỏi sẽ được trả lời từ nguồn nào.

## Cài đặt & chạy
1. Copy file mẫu thành cấu hình thật:
   ```bash
   cp config.example.json config.json
   ```
2. Mở `config.json`, điền **token 1Office** và các thông số (baseUrl, source, campaign...).
3. Chạy server (cần Node.js):
   ```bash
   node server.js
   ```
4. Mở trình duyệt:
   - Landing/form: http://localhost:3000/index.html
   - Bảng dữ liệu: http://localhost:3000/tuyen-dung.html
   - Kanban: http://localhost:3000/kanban.html

## Deploy lên Railway
App là Node thuần (không cần `npm install`). `config.json` (chứa token) **không** được đưa lên, nên trên Railway token lấy từ **biến môi trường**.

1. Tạo project trên [Railway](https://railway.app) → Deploy from GitHub repo (hoặc dùng Railway CLI: `railway init` rồi `railway up`).
2. Vào tab **Variables**, thêm các biến:
   - `ONEOFFICE_TOKEN` = token 1Office (BẮT BUỘC)
   - `ONEOFFICE_WRITE_TOKEN` = token có quyền insert (nếu tách riêng; để trống = dùng token trên)
   - `APPLY_SOURCE` = mã nguồn cho form web (vd `49`) *(tùy chọn)*
   - `APPLY_CAMPAIGN` = mã chiến dịch mặc định *(tùy chọn)*
   - `ONEOFFICE_BASEURL` = ghi đè baseUrl nếu cần *(tùy chọn)*
3. Railway tự nhận `package.json` (start = `node server.js`) và `railway.json`. PORT do Railway cấp tự động qua `process.env.PORT`.

Các giá trị không bí mật (baseUrl, endpoints, fieldMap) lấy từ `config.example.json`.

## Bảo mật
- Token 1Office được giữ phía server (env var khi deploy / `config.json` khi chạy local) — trình duyệt không thấy.
- **Không commit `config.json`** (đã có trong `.gitignore`).

---
© 2026 Thịnh Thế Vinh Hoa F&B Group · Powered by KOHADA
