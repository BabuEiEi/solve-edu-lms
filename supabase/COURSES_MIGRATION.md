**Courses Migration**

**Score Matrix Admin RPC (ใหม่)**

สำหรับให้ `admin/staff` แก้ไข/ลบ/ยกเลิกคะแนนได้แม้เปิด RLS:

1. เปิดไฟล์ [score_matrix_admin_rpcs.sql](/Users/Phuttarapoln%20K./Workspace/solve-edu-lms/supabase/score_matrix_admin_rpcs.sql)
2. รัน SQL ทั้งไฟล์ใน Supabase SQL Editor
3. SQL นี้จะสร้างตาราง `quiz_result_audit_logs` สำหรับเก็บประวัติผู้แก้ไข/เวลาแก้ไขอัตโนมัติ
4. Deploy หน้าเว็บเวอร์ชันล่าสุด

มี 2 วิธีสำหรับย้ายข้อมูล `Courses` ไป Supabase

**วิธีที่ 1: SQL ตรง**

1. รัน [courses.sql](/Users/Phuttarapoln%20K./Workspace/solve-edu-lms/supabase/courses.sql) เพื่อสร้างตารางและ policy
2. เปิด [courses_seed_template.sql](/Users/Phuttarapoln%20K./Workspace/solve-edu-lms/supabase/courses_seed_template.sql)
3. แทนค่าตัวอย่างด้วยข้อมูลจริงจาก Google Sheet
4. นำ SQL ไปวางใน Supabase SQL Editor แล้วรัน

คอลัมน์ที่รองรับ:
- `course_id`
- `course_name`
- `instructor`
- `status`
- `video_url`
- `material_link`
- `description`

**วิธีที่ 2: Import จาก JSON/CSV/TSV**

1. รัน [courses.sql](/Users/Phuttarapoln%20K./Workspace/solve-edu-lms/supabase/courses.sql) ก่อน
2. เตรียมไฟล์ข้อมูล เช่น `courses.json` หรือ `courses.csv`
3. ตั้ง env:

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
```

4. รัน:

```bash
npm run import:courses -- ./courses.json
```

หรือ

```bash
npm run import:courses -- ./courses.csv
```

รูปแบบ header ที่รองรับ:

```text
course_id,course_name,instructor,status,video_url,material_link,description
```

รองรับ alias เดิมจาก Google Sheet:
- `C (instructor)` จะถูก map เป็น `instructor`

**ตัวอย่าง JSON**

```json
[
  {
    "course_id": "COURSE-001",
    "course_name": "หลักสูตรตัวอย่าง",
    "instructor": "ชื่อผู้สอน",
    "status": "เปิดสอน",
    "video_url": "https://www.youtube.com/embed/VIDEO_ID",
    "material_link": "https://example.com/material",
    "description": "คำอธิบายรายวิชา"
  }
]
```
