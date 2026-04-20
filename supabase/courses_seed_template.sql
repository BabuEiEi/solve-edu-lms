insert into public.courses (
  course_id,
  course_name,
  instructor,
  status,
  video_url,
  material_link,
  description
)
values
  (
    'COURSE-001',
    'ตัวอย่างรายวิชา 1',
    'ชื่อผู้สอน',
    'เปิดสอน',
    'https://www.youtube.com/embed/VIDEO_ID',
    'https://example.com/material-1',
    'คำอธิบายรายวิชา 1'
  ),
  (
    'COURSE-002',
    'ตัวอย่างรายวิชา 2',
    'ชื่อผู้สอน',
    'เปิดสอน',
    null,
    'https://example.com/material-2',
    'คำอธิบายรายวิชา 2'
  )
on conflict (course_id) do update
set
  course_name = excluded.course_name,
  instructor = excluded.instructor,
  status = excluded.status,
  video_url = excluded.video_url,
  material_link = excluded.material_link,
  description = excluded.description;
