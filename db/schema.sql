-- ============================================================
--  DocFlow — PostgreSQL schema
--  เดิม: 1 บริษัท = 1 Google Sheet  →  ใหม่: ฐานข้อมูลเดียว แยกบริษัทด้วย tenant_id
--  รันซ้ำได้ (CREATE ... IF NOT EXISTS) ระบบรันไฟล์นี้อัตโนมัติทุกครั้งที่เปิดเซิร์ฟเวอร์
-- ============================================================

-- ---------- ทะเบียนกลาง (เดิม: แท็บ Tenants / Users / Licenses ในชีตหลัก) ----------
CREATE TABLE IF NOT EXISTS tenants (
  id            uuid PRIMARY KEY,
  company_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active',          -- active | disabled
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY,
  username         text NOT NULL UNIQUE,
  display_name     text,
  password_hash    text NOT NULL,
  salt             text NOT NULL,
  role             text NOT NULL DEFAULT 'staff',        -- admin | audit | staff | viewer
  tenant_ids       text NOT NULL DEFAULT '',             -- '*' = ทุกบริษัท หรือ uuid คั่นด้วย ,
  status           text NOT NULL DEFAULT 'active',       -- active | disabled
  email            text,
  is_super         boolean NOT NULL DEFAULT false,
  license_plan     text,                                 -- monthly | yearly | custom | (ว่าง = ไม่จำกัด)
  license_start    date,
  license_expire   date,
  license_note     text,
  license_notified text,
  license_key      text,
  session_id       text,                                 -- 1 บัญชี = 1 เครื่องที่ล็อกอินอยู่
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login       timestamptz
);

CREATE TABLE IF NOT EXISTS license_keys (
  license_key   text PRIMARY KEY,
  plan          text NOT NULL,
  months        integer,
  status        text NOT NULL DEFAULT 'unused',          -- unused | active | used | revoked
  user_id       uuid,
  username      text,
  issued_at     date,
  issued_by     text,
  activated_at  date,
  start_date    date,
  expires_at    date,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key    text PRIMARY KEY,
  value  text
);

-- ---------- ข้อมูลของแต่ละบริษัท ----------
CREATE TABLE IF NOT EXISTS company_profiles (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  company_name    text NOT NULL,
  company_tax_id  text,
  company_address text,
  company_phone   text,
  company_email   text,
  signatory_name  text,
  branch          text,
  vat_registered  text DEFAULT 'yes',                    -- yes | no
  logo            bytea,                                 -- เดิมเก็บใน Drive ตอนนี้เก็บในฐานข้อมูล (≤ 2 MB)
  logo_mime       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             text NOT NULL,
  type               text NOT NULL,                      -- quotation | invoice | taxinvoice | receipt | cashsale
  date               date NOT NULL,
  due_date           date,
  company_id         uuid,
  customer_name      text,
  customer_tax_id    text,
  customer_address   text,
  customer_phone     text,
  project_name       text,
  subtotal           numeric(14,2) NOT NULL DEFAULT 0,
  discount           numeric(14,2) NOT NULL DEFAULT 0,
  vat_rate           numeric(5,2)  NOT NULL DEFAULT 7,
  vat_amount         numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL DEFAULT 0,
  wht_rate           numeric(5,2)  NOT NULL DEFAULT 0,
  notes              text,
  status             text NOT NULL DEFAULT 'draft',      -- draft | issued | paid | cancelled
  source_document_id uuid,
  variant            text,
  pay_methods        text,
  pay_bank           text,
  pay_no             text,
  pay_date           date,
  pay_amount         numeric(14,2),
  edit_count         integer NOT NULL DEFAULT 0,
  last_edit_reason   text,
  last_edited_at     timestamptz,
  last_edited_by     text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS documents_tenant_date ON documents (tenant_id, date);
CREATE INDEX IF NOT EXISTS documents_source ON documents (source_document_id);

CREATE TABLE IF NOT EXISTS document_items (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no      integer NOT NULL DEFAULT 0,
  description  text NOT NULL,
  quantity     numeric(14,3) NOT NULL,
  unit         text,
  price        numeric(14,2) NOT NULL DEFAULT 0,
  discount     numeric(14,2) NOT NULL DEFAULT 0,
  amount       numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS document_items_doc ON document_items (document_id, line_no);

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  ts           timestamptz NOT NULL DEFAULT now(),
  document_id  text,
  action       text,
  detail       text,
  username     text
);
CREATE INDEX IF NOT EXISTS audit_log_doc ON audit_log (tenant_id, document_id);

CREATE TABLE IF NOT EXISTS uploads (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  uploaded_by        text,
  customer_name      text,
  month              text,
  folder_id          text,
  file_id            text,
  file_name          text,
  mime_type          text,
  size               integer,
  file_url           text,
  doc_type           text,
  doc_no             text,
  doc_date           date,
  tax_id             text,
  amount_before_vat  numeric(14,2),
  vat_rate           numeric(5,2),
  vat_amount         numeric(14,2),
  amount_total       numeric(14,2),
  note               text,
  status             text NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS uploads_tenant_docno ON uploads (tenant_id, doc_no);

-- สำเนา PDF ที่สำรองไว้ใน Drive (ใช้แทนการค้นหาไฟล์ด้วยชื่อ)
CREATE TABLE IF NOT EXISTS pdf_backups (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_id      text NOT NULL,
  doc_number  text NOT NULL,
  doc_type    text,
  file_id     text NOT NULL,
  path        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pdf_backups_doc ON pdf_backups (tenant_id, doc_number);

CREATE TABLE IF NOT EXISTS contacts (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            text NOT NULL DEFAULT 'customer',      -- customer | vendor | both
  name            text NOT NULL,
  tax_id          text,
  branch          text,
  address         text,
  phone           text,
  email           text,
  contact_person  text,
  credit_days     integer,
  note            text,
  status          text NOT NULL DEFAULT 'active',
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_tenant ON contacts (tenant_id);

CREATE TABLE IF NOT EXISTS products (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku            text,
  name           text NOT NULL,
  type           text NOT NULL DEFAULT 'goods',          -- goods | service
  unit           text,
  price          numeric(14,2) NOT NULL DEFAULT 0,
  cost           numeric(14,2) NOT NULL DEFAULT 0,
  vat_type       text DEFAULT 'vat',                     -- vat | novat
  stock_tracked  text DEFAULT 'no',                      -- yes | no
  stock_qty      numeric(14,3) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active',
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_tenant ON products (tenant_id);

CREATE TABLE IF NOT EXISTS expense_categories (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort        integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             text NOT NULL,
  date               date NOT NULL,
  credit_days        integer NOT NULL DEFAULT 0,
  due_date           date,
  vendor_id          text,
  vendor_name        text,
  vendor_tax_id      text,
  vendor_address     text,
  vendor_branch      text,
  project_name       text,
  ref_no             text,
  price_type         text DEFAULT 'exclude',             -- exclude | include | none
  category           text,
  description        text,
  subtotal           numeric(14,2) NOT NULL DEFAULT 0,
  discount_pct       numeric(6,2)  NOT NULL DEFAULT 0,
  discount_amt       numeric(14,2) NOT NULL DEFAULT 0,
  amount_before_vat  numeric(14,2) NOT NULL DEFAULT 0,
  vat_rate           numeric(5,2)  NOT NULL DEFAULT 0,
  vat_amount         numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL DEFAULT 0,
  wht_rate           numeric(5,2)  NOT NULL DEFAULT 0,
  wht_amount         numeric(14,2) NOT NULL DEFAULT 0,
  pay_method         text,
  pay_ref            text,
  notes              text,
  internal_notes     text,
  currency           text DEFAULT 'THB',
  status             text NOT NULL DEFAULT 'paid',       -- paid | unpaid | cancelled
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS expenses_tenant_date ON expenses (tenant_id, date);

CREATE TABLE IF NOT EXISTS expense_items (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expense_id   uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  line_no      integer NOT NULL DEFAULT 0,
  category     text,
  description  text,
  quantity     numeric(14,3) NOT NULL DEFAULT 1,
  unit         text,
  price        numeric(14,2) NOT NULL DEFAULT 0,
  amount       numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS expense_items_exp ON expense_items (expense_id, line_no);

CREATE TABLE IF NOT EXISTS purchase_docs (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             text NOT NULL,
  type               text NOT NULL,                      -- po | gr
  date               date NOT NULL,
  expected_date      date,
  company_id         uuid,
  vendor_id          text,
  vendor_name        text,
  vendor_tax_id      text,
  vendor_address     text,
  vendor_phone       text,
  subtotal           numeric(14,2) NOT NULL DEFAULT 0,
  discount           numeric(14,2) NOT NULL DEFAULT 0,
  vat_rate           numeric(5,2)  NOT NULL DEFAULT 7,
  vat_amount         numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL DEFAULT 0,
  notes              text,
  status             text NOT NULL DEFAULT 'draft',      -- draft | issued | received | cancelled
  source_document_id uuid,
  stock_applied      text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id   uuid NOT NULL REFERENCES purchase_docs(id) ON DELETE CASCADE,
  line_no       integer NOT NULL DEFAULT 0,
  product_id    text,
  description   text NOT NULL,
  quantity      numeric(14,3) NOT NULL,
  received_qty  numeric(14,3),
  unit          text,
  price         numeric(14,2) NOT NULL DEFAULT 0,
  discount      numeric(14,2) NOT NULL DEFAULT 0,
  amount        numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS purchase_items_doc ON purchase_items (document_id, line_no);

-- ถังขยะ: ไฟล์ที่ถูกลบจะย้ายไป Storage/99 ถังขยะ เก็บไว้ TRASH_KEEP_DAYS วัน (ค่าเริ่มต้น 30) แล้วลบถาวรอัตโนมัติ
-- ดู/กู้คืนได้เฉพาะ Super Admin
CREATE TABLE IF NOT EXISTS trash_items (
  id               uuid PRIMARY KEY,
  tenant_id        uuid REFERENCES tenants(id) ON DELETE SET NULL,
  company_name     text,
  kind             text NOT NULL,             -- upload | pdf | file | document | expense | purchase
  ref_id           text,                      -- uploads.id (kind = upload) / documents.id (kind = pdf)
  label            text,                      -- คำอธิบาย เช่น ลูกค้า / เลขที่เอกสาร
  file_name        text NOT NULL,
  mime_type        text,
  size             integer,
  original_folder  text NOT NULL,             -- โฟลเดอร์เดิม (ใช้ตอนกู้คืน)
  original_path    text,                      -- ที่อยู่เดิมแบบอ่านได้
  trash_file_id    text,                      -- ตำแหน่งไฟล์ในถังขยะ (ว่าง = ไม่พบไฟล์ตอนลบ)
  deleted_by       text,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'trashed',   -- trashed | restored | purged
  restored_by      text,
  restored_at      timestamptz
);
ALTER TABLE trash_items ALTER COLUMN trash_file_id DROP NOT NULL;
-- เอกสารที่ลบ: เก็บข้อมูลทั้งชุดไว้กู้คืน + ไฟล์แนบที่ลบพร้อมกันอยู่ในกลุ่มเดียวกัน
ALTER TABLE trash_items ADD COLUMN IF NOT EXISTS doc_type   text;
ALTER TABLE trash_items ADD COLUMN IF NOT EXISTS doc_number text;
ALTER TABLE trash_items ADD COLUMN IF NOT EXISTS payload    jsonb;
ALTER TABLE trash_items ADD COLUMN IF NOT EXISTS group_id   uuid;
CREATE INDEX IF NOT EXISTS trash_items_group ON trash_items (group_id);
CREATE INDEX IF NOT EXISTS trash_items_docno ON trash_items (tenant_id, doc_number);
CREATE INDEX IF NOT EXISTS trash_items_status ON trash_items (status, expires_at);

-- ผู้สร้างผู้ใช้ / บริษัท (ว่าง = สร้างโดย Super Admin หรือมีอยู่ก่อนแล้ว)
-- Admin และผู้ตรวจสอบเห็น/แก้ได้เฉพาะผู้ใช้ที่ตนสร้าง (รวมผู้ใช้ที่ผู้ใช้เหล่านั้นสร้างต่อ)
ALTER TABLE users   ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_by uuid;
CREATE INDEX IF NOT EXISTS users_created_by ON users (created_by);

-- สมัครใช้งานเอง (ทดลองใช้ฟรี)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone       text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_at   timestamptz;

-- แชทติดต่อเจ้าหน้าที่ (ผู้ใช้ 1 คน = 1 ห้อง กับ Super Admin)
CREATE TABLE IF NOT EXISTS chat_threads (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'open',      -- open (รอตอบ) | answered (ตอบแล้ว) | closed (ปิดเรื่อง)
  last_msg_at   timestamptz NOT NULL DEFAULT now(),
  last_preview  text,
  last_from     text,                              -- user | staff
  user_unread   integer NOT NULL DEFAULT 0,        -- ข้อความจากเจ้าหน้าที่ที่ผู้ใช้ยังไม่อ่าน
  staff_unread  integer NOT NULL DEFAULT 0,        -- ข้อความจากผู้ใช้ที่เจ้าหน้าที่ยังไม่อ่าน
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_threads_last ON chat_threads (last_msg_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id           bigserial PRIMARY KEY,
  thread_id    uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id    uuid,
  sender_name  text,
  sender_role  text NOT NULL,                      -- user | staff
  body         text,
  file_id      text,
  file_name    text,
  mime_type    text,
  size         integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages (thread_id, id);

-- ติดตามการใช้งาน (เมนู "ติดตามผู้ใช้งาน")
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen  timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_agent text;
CREATE TABLE IF NOT EXISTS login_events (
  id        bigserial PRIMARY KEY,
  user_id   uuid,
  username  text,
  at        timestamptz NOT NULL DEFAULT now(),
  ok        boolean NOT NULL,
  ip        text,
  agent     text,
  note      text                                  -- login | signup | ผิดรหัสผ่าน ฯลฯ
);
CREATE INDEX IF NOT EXISTS login_events_at ON login_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts DESC);

-- ===== ประกาศจาก Super Admin ถึงผู้ใช้ทุกคน =====
CREATE TABLE IF NOT EXISTS announcements (
  id           bigserial PRIMARY KEY,
  message      text NOT NULL,
  level        text NOT NULL DEFAULT 'info',     -- info (ข่าวสาร) | maint (ปิดปรับปรุง) | urgent (สำคัญ)
  starts_at    timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz,
  popup        boolean NOT NULL DEFAULT true,     -- เด้งหน้าต่างให้กดรับทราบ
  created_by   uuid,
  created_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  stopped_at   timestamptz
);
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id bigint NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

-- ===== Telegram: จับคู่ข้อความใน Telegram กับห้องแชท (ใช้ตอนกด Reply) =====
CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id     text NOT NULL,
  message_id  bigint NOT NULL,
  thread_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

-- ===== คำขอลบบริษัท (ผู้ใช้ขอ → Super Admin อนุมัติ) =====
CREATE TABLE IF NOT EXISTS delete_requests (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL DEFAULT 'tenant',
  target_id       uuid NOT NULL,
  target_name     text,
  reason          text,
  status          text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
  requested_by    uuid,
  requested_name  text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid,
  decided_name    text,
  decided_at      timestamptz,
  decision_note   text
);
CREATE INDEX IF NOT EXISTS delete_requests_status ON delete_requests (status, requested_at DESC);

-- ===== ไฟล์ข้อมูลทั้งบริษัท (.zip) สำหรับส่งมอบให้ลูกค้า =====
CREATE TABLE IF NOT EXISTS company_exports (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  tenant_name       text,
  status            text NOT NULL DEFAULT 'building',   -- building | ready | error | expired
  file_name         text,
  size              bigint,
  files             integer,
  created_by        uuid,
  created_name      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  expires_at        timestamptz,
  downloads         integer NOT NULL DEFAULT 0,
  last_download_at  timestamptz,
  last_download_by  text,
  request_id        bigint,
  error             text
);
CREATE INDEX IF NOT EXISTS company_exports_tenant ON company_exports (tenant_id, created_at DESC);

-- ===== ดัชนีสำหรับรายการเอกสาร (เรียงตามแก้ไขล่าสุด) — ให้หน้าเอกสารเร็วแม้มีหลายหมื่นใบ =====
CREATE INDEX IF NOT EXISTS documents_tenant_updated ON documents (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS purchase_docs_tenant_updated ON purchase_docs (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS expenses_tenant_date ON expenses (tenant_id, date);
CREATE INDEX IF NOT EXISTS expense_items_tenant_exp ON expense_items (tenant_id, expense_id);

-- ===== รูปโปรไฟล์ผู้ใช้ (รูปเล็ก เก็บในฐานข้อมูล) =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime text;

-- ===== โควตาจำนวนผู้ใช้ที่แต่ละเจ้าของบัญชีสร้างได้ =====
-- NULL = ใช้ค่าเริ่มต้นของระบบ · -1 = ไม่จำกัด · N = สร้างได้สูงสุด N คน
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_quota int;

-- ===== โควตาจำนวนบริษัทที่แต่ละเจ้าของบัญชีสร้างได้ =====
-- NULL = ใช้ค่าเริ่มต้นของระบบ · -1 = ไม่จำกัด · N = สร้างได้สูงสุด N บริษัท
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_quota int;

-- ===== คำขอเพิ่มสิทธิ์จากผู้ใช้ → Super Admin อนุมัติ (เพิ่มบริษัท / เพิ่มผู้ใช้) =====
CREATE TABLE IF NOT EXISTS upgrade_requests (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL,                       -- 'company' | 'user'
  amount          int NOT NULL DEFAULT 1,              -- จำนวนที่ขอเพิ่ม
  reason          text,
  status          text NOT NULL DEFAULT 'pending',     -- pending | approved | rejected | cancelled
  requested_by    uuid,
  requested_name  text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid,
  decided_name    text,
  decided_at      timestamptz,
  granted         int,                                 -- จำนวนที่อนุมัติจริง
  decision_note   text
);
CREATE INDEX IF NOT EXISTS upgrade_requests_status ON upgrade_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS upgrade_requests_by ON upgrade_requests (requested_by, requested_at DESC);
