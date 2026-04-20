import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const inputPath = process.argv[2]

if (!inputPath) {
  console.error('Usage: npm run import:courses -- <path-to-courses.json|csv|tsv>')
  process.exit(1)
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (recommended) or a usable anon key env var.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const absoluteInputPath = path.resolve(process.cwd(), inputPath)
const rawText = fs.readFileSync(absoluteInputPath, 'utf8')
const extension = path.extname(absoluteInputPath).toLowerCase()

function parseDelimited(text, delimiter) {
  const rows = []
  let current = ''
  let row = []
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === delimiter && !inQuotes) {
      row.push(current)
      current = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1
      row.push(current)
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
      current = ''
      continue
    }

    current += char
  }

  row.push(current)
  if (row.some((cell) => cell !== '')) rows.push(row)
  return rows
}

function normalizeCourse(record) {
  return {
    course_id: String(record.course_id || '').trim(),
    course_name: String(record.course_name || '').trim(),
    instructor: String(record.instructor || record['C (instructor)'] || '').trim() || null,
    status: String(record.status || 'เปิดสอน').trim(),
    video_url: String(record.video_url || '').trim() || null,
    material_link: String(record.material_link || '').trim() || null,
    description: String(record.description || '').trim() || null
  }
}

function parseInput(text, ext) {
  if (ext === '.json') {
    const json = JSON.parse(text)
    if (!Array.isArray(json)) throw new Error('JSON root must be an array')
    return json.map(normalizeCourse)
  }

  const delimiter = ext === '.tsv' ? '\t' : ','
  const rows = parseDelimited(text, delimiter)
  if (rows.length < 2) return []

  const headers = rows[0].map((header) => header.trim())
  return rows.slice(1).map((cells) => {
    const record = {}
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? ''
    })
    return normalizeCourse(record)
  })
}

const courses = parseInput(rawText, extension).filter((course) => course.course_id && course.course_name)

if (courses.length === 0) {
  console.error('No valid courses found in input file.')
  process.exit(1)
}

const duplicateIds = courses
  .map((course) => course.course_id)
  .filter((courseId, index, list) => list.indexOf(courseId) !== index)

if (duplicateIds.length > 0) {
  console.error(`Duplicate course_id values found: ${[...new Set(duplicateIds)].join(', ')}`)
  process.exit(1)
}

const { error } = await supabase
  .from('courses')
  .upsert(courses, { onConflict: 'course_id' })

if (error) {
  console.error(`Import failed: ${error.message}`)
  process.exit(1)
}

console.log(`Imported ${courses.length} courses into public.courses`)
