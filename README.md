# TTVH Tuyển Dụng — Thịnh Thế Vinh Hoa F&B Group

Landing page tuyển dụng + bảng dữ liệu + Kanban phân loại ứng viên, kết nối API 1Office.

## Thành phần
- `index.html` — Landing page tuyển dụng + form ứng tuyển (đẩy hồ sơ vào 1Office).
- `tuyen-dung.html` — Bảng dữ liệu ứng viên/đề xuất/chiến dịch/kênh từ 1Office.
- `kanban.html` — Kanban phân loại hồ sơ ứng viên theo giai đoạn (mới cập nhật lên đầu, tự báo dữ liệu mới).
- `server.js` — Proxy Node (chỉ dùng module built-in, **không cần `npm install`**) giữ token an toàn, tránh CORS, và nhận form ứng tuyển.
- `config.example.json` — Mẫu cấu hình. **`config.json` thật (chứa token) không được đưa lên git.**
- `images/` — Logo các thương hiệu (MayCha, Tam Hảo, Gà Giòn Ba Cô Gái, Trà Hú) + ảnh.

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

## Bảo mật
- Token 1Office được giữ ở `server.js`/`config.json` phía server — trình duyệt không thấy.
- **Không commit `config.json`** (đã có trong `.gitignore`).

---
© 2026 Thịnh Thế Vinh Hoa F&B Group · Powered by KOHADA
