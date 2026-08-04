# TTVH Tuyển Dụng — hướng dẫn làm việc

## Deploy
- Repo này deploy tự động lên Railway khi push lên `origin/main` (Railway theo dõi GitHub repo).
- **Sau khi chỉnh sửa xong và đã xác nhận hoạt động đúng, tự động `git add` + `git commit` + `git push origin main`** — không cần hỏi lại xác nhận cho bước push. Chỉ dừng lại hỏi nếu:
  - Thay đổi có khả năng phá vỡ production (đổi schema DB theo hướng không tương thích ngược, xóa endpoint đang dùng, đổi biến môi trường bắt buộc...).
  - Có xung đột hoặc lịch sử git bất thường (working tree không sạch trước khi bắt đầu, remote đã có commit mới hơn, v.v.).
- Không dùng `--force`, không sửa lịch sử commit đã push.
- `config.json` chứa token thật — không bao giờ commit (đã có trong `.gitignore`).
