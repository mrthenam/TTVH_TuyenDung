/* Quy tắc lọc việc làm dùng chung cho trang chủ (mục Cơ hội nghề nghiệp) và trang Việc làm.
   Để chung một chỗ nhằm đảm bảo số vị trí đếm ở trang chủ luôn khớp với kết quả lọc
   thực tế khi bấm sang viec-lam.html. */
(function (root) {
  // Bỏ dấu tiếng Việt để so khớp từ khóa không phân biệt dấu/hoa thường
  function normVi(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd'); }

  // Khối công việc: tham số URL ?dept=... <-> nhãn hiển thị trong dữ liệu tin
  var DEPT_MAP = { store: 'Cửa hàng', office: 'Văn phòng', sanxuat: 'Khối sản xuất' };

  // Gom địa điểm theo khu vực. Dropdown LUÔN hiện cố định 5 mục:
  // TP. Hồ Chí Minh · Hà Nội · Miền Nam · Miền Bắc · Miền Trung.
  // Nhận diện qua từ khóa (không dấu) trong chuỗi địa điểm của tin.
  var LOC_HCM = ['ho chi minh', 'hcm', 'sai gon', 'thu duc', 'quan 1', 'quan 2', 'quan 3', 'quan 4', 'quan 5', 'quan 6', 'quan 7', 'quan 8', 'quan 9', 'quan 10', 'quan 11', 'quan 12', 'binh tan', 'tan phu', 'tan binh', 'binh thanh', 'go vap', 'phu nhuan', 'hoc mon', 'binh chanh', 'nha be', 'cu chi', 'tan tao', 'huynh tinh cua'];
  var LOC_HN = ['ha noi', 'cau giay', 'dong da', 'ba dinh', 'hoan kiem', 'tay ho', 'thanh xuan', 'hoang mai', 'long bien', 'tu liem', 'ha dong', 'chua lang'];
  var LOC_SOUTH = ['binh duong', 'di an', 'thuan an', 'thu dau mot', 'dong nai', 'bien hoa', 'ba ria', 'vung tau', 'long an', 'tien giang', 'my tho', 'an giang', 'long xuyen', 'chau doc', 'can tho', 'tay ninh', 'binh phuoc', 'dong thap', 'cao lanh', 'sa dec', 'vinh long', 'ben tre', 'tra vinh', 'soc trang', 'bac lieu', 'ca mau', 'kien giang', 'rach gia', 'phu quoc', 'hau giang'];
  var LOC_NORTH = ['hai phong', 'quang ninh', 'ha long', 'bac ninh', 'hai duong', 'hung yen', 'nam dinh', 'thai binh', 'vinh phuc', 'phu tho', 'viet tri', 'bac giang', 'thai nguyen', 'lang son', 'ha nam', 'ninh binh', 'hoa binh', 'lao cai', 'yen bai', 'tuyen quang', 'cao bang', 'bac kan', 'son la', 'dien bien', 'lai chau', 'ha giang'];
  var LOC_CENTRAL = ['da nang', 'hue', 'thua thien', 'quang nam', 'hoi an', 'tam ky', 'quang ngai', 'binh dinh', 'quy nhon', 'phu yen', 'tuy hoa', 'khanh hoa', 'nha trang', 'cam ranh', 'ninh thuan', 'phan rang', 'binh thuan', 'phan thiet', 'thanh hoa', 'nghe an', 'ha tinh', 'quang binh', 'dong hoi', 'quang tri', 'dong ha', 'lam dong', 'da lat', 'bao loc', 'dak lak', 'buon ma thuot', 'buon me thuot', 'gia lai', 'pleiku', 'kon tum', 'dak nong', 'tay nguyen'];
  var LOC_REGIONS = [
    { label: 'TP. Hồ Chí Minh', kw: LOC_HCM },
    { label: 'Hà Nội', kw: LOC_HN },
    { label: 'Miền Nam', kw: LOC_HCM.concat(LOC_SOUTH) },
    { label: 'Miền Bắc', kw: LOC_HN.concat(LOC_NORTH) },
    { label: 'Miền Trung', kw: LOC_CENTRAL }
  ];
  function locMatchRegion(loc, label) {
    var reg = null;
    LOC_REGIONS.forEach(function (r) { if (r.label === label) reg = r; });
    if (!reg) return true;
    var n = ' ' + normVi(loc) + ' ';
    return reg.kw.some(function (k) { return n.indexOf(k) >= 0; });
  }

  // Bộ lọc phụ theo Khối: Cửa hàng -> Thương hiệu; Văn phòng / Khối sản xuất -> Bộ phận.
  // Tin không có cột brand/bộ phận nên nhận diện bằng TỪ KHÓA (không dấu) trong tiêu đề tin.
  var SUB_FILTERS = {
    'Cửa hàng': {
      label: 'Thương hiệu',
      options: [
        { v: 'maycha', label: 'MayCha', kw: ['maycha', 'may cha'] },
        { v: 'tamhao', label: 'Hồng Trà Sữa Tam Hảo', kw: ['tam hao'] },
        { v: 'gagion', label: 'Gà Giòn Sốt Ba Cô Gái', kw: ['ga gion', 'ba co gai', 'ga ran'] },
        { v: 'trahu', label: 'Trà Hú', kw: ['tra hu'] }
      ]
    },
    'Văn phòng': {
      label: 'Bộ phận',
      options: [
        { v: 'marketing', label: 'Marketing', kw: ['marketing', 'marcom', 'media', 'tiktok', 'social', 'content', 'truyen thong', 'quang cao', 'trade'] },
        { v: 'hr', label: 'Nhân sự (HR)', kw: ['nhan su', 'tuyen dung', 'dao tao', 'hr ', '(hr)', 'c&b'] },
        { v: 'scm', label: 'Quản lý cung ứng (SCM)', kw: ['cung ung', 'scm', 'mua hang', 'kho van', 'logistics', 'purchasing', 'supply'] },
        { v: 'finance', label: 'Tài chính – Kế toán', kw: ['ke toan', 'tai chinh', 'finance', 'kiem soat', 'audit'] },
        { v: 'other', label: 'Các công việc khác', kw: null }
      ]
    },
    'Khối sản xuất': {
      label: 'Bộ phận',
      options: [
        // "kho" phải kèm dấu phân cách vì "không" (bỏ dấu -> "khong") cũng chứa "kho"
        { v: 'khovan', label: 'Kho vận', kw: ['kho/', ' kho ', ' kho,', 'kho van', 'thu kho', 'soan hang', 'logistics', 'giao van', 'van chuyen', 'tai xe'] },
        { v: 'sanxuat', label: 'Sản xuất / Vận hành', kw: ['san xuat', 'van hanh', 'cong nhan', 'che bien', 'dinh luong', 've sinh', 'tap vu'] },
        { v: 'qaqc', label: 'QA / QC', kw: ['qa/qc', ' qa ', ' qc ', 'chat luong', 'atvstp', 'kiem nghiem', 'kiem dinh'] },
        { v: 'kythuat', label: 'Kỹ thuật / Bảo trì', kw: ['ky thuat', 'bao tri', 'co dien', 'sua chua', 'thiet bi'] }
      ]
    }
  };
  function subMatch(j, dept, val) {
    var cfg = SUB_FILTERS[dept];
    if (!cfg || !val) return true;
    var t = ' ' + normVi(j.title) + ' ';
    function hit(opt) { return !!opt.kw && opt.kw.some(function (k) { return t.indexOf(k) >= 0; }); }
    var opt = null;
    cfg.options.forEach(function (o) { if (o.v === val) opt = o; });
    if (!opt) return true;
    if (opt.kw) return hit(opt);
    return !cfg.options.some(hit); // "Các công việc khác" = không khớp nhóm nào ở trên
  }

  // Một tin có khớp đồng thời Khối + Bộ phận/Thương hiệu + Khu vực không?
  function jobMatches(j, deptLabel, sub, locLabel) {
    if (deptLabel && j.dept !== deptLabel) return false;
    if (sub && !subMatch(j, deptLabel, sub)) return false;
    if (locLabel && !locMatchRegion(j.location, locLabel)) return false;
    return true;
  }

  root.JobFilters = {
    normVi: normVi,
    DEPT_MAP: DEPT_MAP,
    LOC_REGIONS: LOC_REGIONS,
    locMatchRegion: locMatchRegion,
    SUB_FILTERS: SUB_FILTERS,
    subMatch: subMatch,
    jobMatches: jobMatches
  };
})(window);
