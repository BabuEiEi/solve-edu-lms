import './style.css'
import { supabase } from './supabaseClient.js'

// ==========================================
// 1. ตั้งค่าพื้นฐาน
// ==========================================
const COURSES_TABLE = 'courses'
const QUIZ_QUESTIONS_TABLE = 'quiz_questions'
const QUIZ_RESULTS_TABLE = 'quiz_results'
const VIDEO_QUESTIONS_TABLE = 'video_questions'
const VIDEO_WATCH_LOGS_TABLE = 'video_watch_logs'
const PROFILE_IMAGE_BUCKET = 'profile-images'
const PROFILE_IMAGE_MAX_SIZE_BYTES = 2 * 1024 * 1024
const PROFILE_IMAGE_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const PROFILE_IMAGE_OUTPUT_SIZE = 512
const PROFILE_IMAGE_OUTPUT_TYPE = 'image/webp'
const PROFILE_IMAGE_OUTPUT_QUALITY = 0.9

let globalCourses = []
let isEditMode = false
let editingQuizId = null
let quizMatchingPairCount = 3
let quizDragDropItemCount = 3
let currentQuizQuestions = []
let ytPlayer = null
let maxReachedTime = 0
let vqPlayer = null
let videoQuestionsForCourse = []
let answeredVideoQuestions = new Set()
let videoCheckInterval = null
let currentVideoQuestion = null
let currentVQFirstTry = true
let editingVideoQuestionId = null

// เชื่อมต่อ UI
const loginSection = document.getElementById('loginSection')
const mainAppSection = document.getElementById('mainAppSection')
const userEmailDisplay = document.getElementById('userEmailDisplay')
const logoutBtn = document.getElementById('logoutBtn')
const contentArea = document.getElementById('contentArea')
const adminMenuWrapper = document.getElementById('adminMenuWrapper')
const authStatus = document.getElementById('authStatus')

// ==========================================
// 2. ระบบ Sidebar
// ==========================================
const appSidebar = document.getElementById('appSidebar')
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
let isSidebarExpanded = true

function getProfileAvatarUrl(session, profile = null) {
  return (
    profile?.avatar_url ||
    session?.user?.user_metadata?.avatar_url ||
    session?.user?.user_metadata?.picture ||
    ''
  )
}

function renderAvatarMarkup(avatarUrl, altText, fallbackEmoji = '👤') {
  if (avatarUrl) {
    return `<img src="${avatarUrl}" alt="${altText}" class="w-full h-full object-cover">`
  }
  return `<span>${fallbackEmoji}</span>`
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    })
  ])
}

function getStoragePathFromPublicUrl(publicUrl) {
  if (!publicUrl) return ''

  const marker = `/storage/v1/object/public/${PROFILE_IMAGE_BUCKET}/`
  const markerIndex = publicUrl.indexOf(marker)
  if (markerIndex === -1) return ''

  return decodeURIComponent(publicUrl.slice(markerIndex + marker.length))
}

function revokePreviewUrlIfNeeded(previewEl) {
  const previousObjectUrl = previewEl?.dataset?.previewUrl
  if (previousObjectUrl) {
    URL.revokeObjectURL(previousObjectUrl)
    delete previewEl.dataset.previewUrl
  }
}

function setProfilePreviewSource(previewEl, sourceUrl, altText, fallbackEmoji = '🧑‍🎓') {
  if (!previewEl) return

  revokePreviewUrlIfNeeded(previewEl)
  previewEl.innerHTML = renderAvatarMarkup(sourceUrl, altText, fallbackEmoji)
  previewEl.classList.toggle('text-slate-500', !sourceUrl)
  previewEl.classList.toggle('text-transparent', Boolean(sourceUrl))

  if (sourceUrl && sourceUrl.startsWith('blob:')) {
    previewEl.dataset.previewUrl = sourceUrl
  }
}

async function loadImageElement(file) {
  return await new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()

    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพนี้ได้'))
    }

    image.src = objectUrl
  })
}

async function createProcessedProfileImage(file) {
  const image = await loadImageElement(file)
  const cropSize = Math.min(image.naturalWidth, image.naturalHeight)
  const cropX = (image.naturalWidth - cropSize) / 2
  const cropY = (image.naturalHeight - cropSize) / 2

  const canvas = document.createElement('canvas')
  canvas.width = PROFILE_IMAGE_OUTPUT_SIZE
  canvas.height = PROFILE_IMAGE_OUTPUT_SIZE

  const context = canvas.getContext('2d')
  if (!context) throw new Error('ไม่สามารถเตรียมภาพสำหรับอัปโหลดได้')

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    cropX,
    cropY,
    cropSize,
    cropSize,
    0,
    0,
    PROFILE_IMAGE_OUTPUT_SIZE,
    PROFILE_IMAGE_OUTPUT_SIZE
  )

  const processedBlob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('ไม่สามารถแปลงภาพก่อนอัปโหลดได้'))
          return
        }
        resolve(blob)
      },
      PROFILE_IMAGE_OUTPUT_TYPE,
      PROFILE_IMAGE_OUTPUT_QUALITY
    )
  })

  const originalFileName = file.name.replace(/\.[^.]+$/, '') || 'profile-image'
  return new File(
    [processedBlob],
    `${originalFileName}.webp`,
    { type: PROFILE_IMAGE_OUTPUT_TYPE, lastModified: Date.now() }
  )
}

toggleSidebarBtn.addEventListener('click', () => {
  isSidebarExpanded = !isSidebarExpanded
  const sidebarTexts = document.querySelectorAll('.sidebar-text')
  if (isSidebarExpanded) {
    appSidebar.classList.remove('w-20')
    appSidebar.classList.add('w-72')
    setTimeout(() => sidebarTexts.forEach(el => el.classList.remove('hidden', 'opacity-0')), 150)
  } else {
    appSidebar.classList.remove('w-72')
    appSidebar.classList.add('w-20')
    sidebarTexts.forEach(el => {
      el.classList.add('opacity-0')
      setTimeout(() => el.classList.add('hidden'), 150)
    })
  }
})

// ==========================================
// 3. ระบบ Authentication & Role 
// ==========================================
async function updateUI(session) {
  if (session) {
    authStatus.textContent = ''

    const { data: profile } = await supabase
      .from('users_profile')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle()

    // บัญชีใหม่จาก Google ที่ยังไม่มี profile
    if (!profile) {
      await supabase.from('users_profile').insert([{
        id: session.user.id,
        full_name: session.user.user_metadata?.full_name || session.user.email,
        role: 'student',
        status: 'pending'
      }])
      showPendingScreen()
      return
    }

    // ตรวจสอบสถานะการอนุมัติ
    if (profile.status === 'pending') {
      showPendingScreen()
      return
    }
    if (profile.status === 'rejected') {
      showRejectedScreen()
      return
    }

    // approved — เข้าระบบได้ปกติ
    loginSection.classList.add('hidden')
    mainAppSection.classList.remove('hidden')

    let userRole = profile.role || 'student'
    let fullName = profile.full_name || 'ผู้อบรม'
    let avatarUrl = getProfileAvatarUrl(session, profile)

    let displayRole = 'Trainee'
    if (userRole === 'admin') displayRole = 'Admin'
    else if (userRole === 'teacher') displayRole = 'Mentor'
    else if (userRole === 'staff') displayRole = 'Staff'

    const roleBadgeColor = {
      admin: 'bg-indigo-100 text-indigo-700',
      teacher: 'bg-blue-100 text-blue-700',
      staff: 'bg-teal-100 text-teal-700',
      student: 'bg-blue-100 text-blue-700'
    }[userRole] || 'bg-blue-100 text-blue-700'

    userEmailDisplay.innerHTML = `
      <span class="text-slate-800 font-bold truncate block w-44">${fullName}</span>
      <span class="mt-1 px-2 py-0.5 ${roleBadgeColor} text-[10px] font-bold rounded-full inline-block uppercase tracking-wider">${displayRole}</span>
    `

    const sidebarAvatar = document.getElementById('sidebarAvatar')
    if (sidebarAvatar) {
      sidebarAvatar.innerHTML = renderAvatarMarkup(avatarUrl, fullName, '👤')
      sidebarAvatar.classList.toggle('text-slate-500', !avatarUrl)
      sidebarAvatar.classList.toggle('text-transparent', Boolean(avatarUrl))
    }

    const allMenus = ['userMenuWrapper', 'adminMenuWrapper', 'staffMenuWrapper', 'mentorMenuWrapper']
    allMenus.forEach(id => document.getElementById(id)?.classList.add('hidden'))

    if (userRole === 'admin') {
      document.getElementById('adminMenuWrapper').classList.remove('hidden')
      fetchCourses()
      window.loadContent('approvals')
    } else if (userRole === 'staff') {
      document.getElementById('staffMenuWrapper').classList.remove('hidden')
      window.loadContent('staffDashboard')
    } else if (userRole === 'teacher') {
      document.getElementById('mentorMenuWrapper').classList.remove('hidden')
      fetchCourses()
      window.loadContent('mentorDashboard')
    } else {
      document.getElementById('userMenuWrapper').classList.remove('hidden')
      fetchCourses()
      window.loadContent('guidelines')
    }

  } else {
    loginSection.classList.remove('hidden')
    mainAppSection.classList.add('hidden')
    userEmailDisplay.textContent = ''
    contentArea.innerHTML = ''
    document.getElementById('adminModal').classList.add('hidden')
    showLoginForm()
  }
}

function showPendingScreen() {
  loginSection.classList.remove('hidden')
  mainAppSection.classList.add('hidden')
  document.getElementById('loginFormSection').classList.add('hidden')
  document.getElementById('registerFormSection').classList.add('hidden')
  document.getElementById('authSubtitle').textContent = ''
  authStatus.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-center">
      <div class="text-4xl mb-3">⏳</div>
      <p class="font-bold text-amber-700 text-base">รอการอนุมัติจาก Admin</p>
      <p class="text-amber-600 text-sm mt-1">ระบบจะแจ้งให้ทราบเมื่อได้รับการอนุมัติ</p>
      <button onclick="handleLogout()" class="mt-4 text-xs text-slate-400 hover:text-slate-600 underline">ออกจากระบบ</button>
    </div>`
}

function showRejectedScreen() {
  loginSection.classList.remove('hidden')
  mainAppSection.classList.add('hidden')
  document.getElementById('loginFormSection').classList.add('hidden')
  document.getElementById('registerFormSection').classList.add('hidden')
  document.getElementById('authSubtitle').textContent = ''
  authStatus.innerHTML = `
    <div class="bg-red-50 border border-red-200 rounded-xl p-5 text-center">
      <div class="text-4xl mb-3">❌</div>
      <p class="font-bold text-red-700 text-base">คำขอถูกปฏิเสธ</p>
      <p class="text-red-500 text-sm mt-1">กรุณาติดต่อผู้ดูแลระบบ</p>
      <button onclick="handleLogout()" class="mt-4 text-xs text-slate-400 hover:text-slate-600 underline">ออกจากระบบ</button>
    </div>`
}

window.showLoginForm = function showLoginForm() {
  document.getElementById('loginFormSection').classList.remove('hidden')
  document.getElementById('registerFormSection').classList.add('hidden')
  document.getElementById('authSubtitle').textContent = 'เข้าสู่ระบบเพื่อเริ่มการเรียนรู้'
  authStatus.textContent = ''
}

window.showRegisterForm = function showRegisterForm() {
  document.getElementById('loginFormSection').classList.add('hidden')
  document.getElementById('registerFormSection').classList.remove('hidden')
  document.getElementById('authSubtitle').textContent = 'สมัครสมาชิกเพื่อเข้าอบรม'
  authStatus.textContent = ''
}

async function handleLogout() {
  clearStoredAuthSession()
  await supabase.auth.signOut({ scope: 'local' })
  await updateUI(null)
}

function clearStoredAuthSession() {
  const authKeyPattern = /^sb-.*-auth-token$/

  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i)
    if (key && authKeyPattern.test(key)) {
      localStorage.removeItem(key)
    }
  }
}

let _initialSessionHandled = false
supabase.auth.getSession().then(({ data: { session } }) => {
  _initialSessionHandled = true
  updateUI(session)
})
supabase.auth.onAuthStateChange((event, session) => {
  if (!_initialSessionHandled) return
  if (event === 'INITIAL_SESSION') return
  updateUI(session)
})

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById('email').value,
      password: document.getElementById('password').value
    })
    if (error) throw error
  } catch (error) { alert(error.message) }
})

document.getElementById('googleLoginBtn').addEventListener('click', async () => {
  await supabase.auth.signInWithOAuth({ provider: 'google' })
})

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = document.getElementById('reg_name').value.trim()
  const school = document.getElementById('reg_school').value.trim()
  const email = document.getElementById('reg_email').value.trim()
  const password = document.getElementById('reg_password').value

  authStatus.textContent = '⏳ กำลังสมัครสมาชิก...'
  authStatus.className = 'mt-4 text-center text-sm font-medium text-blue-500'

  try {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error

    await supabase.from('users_profile').upsert({
      id: data.user.id,
      full_name: name,
      school_name: school,
      email: email,
      role: 'student',
      status: 'pending'
    })

    await supabase.auth.signOut({ scope: 'local' })
    document.getElementById('registerFormSection').classList.add('hidden')
    document.getElementById('authSubtitle').textContent = ''
    authStatus.innerHTML = `
      <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-5 text-center">
        <div class="text-4xl mb-3">✅</div>
        <p class="font-bold text-emerald-700 text-base">สมัครสมาชิกสำเร็จ!</p>
        <p class="text-emerald-600 text-sm mt-1">รอ Admin อนุมัติก่อนเข้าใช้งานครับ</p>
        <button onclick="showLoginForm()" class="mt-4 text-xs text-blue-600 hover:underline font-bold">กลับหน้าเข้าสู่ระบบ</button>
      </div>`
  } catch (err) {
    authStatus.textContent = `❌ ${err.message}`
    authStatus.className = 'mt-4 text-center text-sm font-medium text-red-500'
  }
})
logoutBtn.addEventListener('click', async () => {
  const originalMarkup = logoutBtn.innerHTML
  const signOutTimeoutMs = 2500

  logoutBtn.disabled = true
  logoutBtn.classList.add('opacity-60', 'cursor-not-allowed')
  logoutBtn.innerHTML = `
    <span class="text-xl w-6 text-center shrink-0">⏳</span><span class="sidebar-text ml-2 whitespace-nowrap">กำลังออกจากระบบ...</span>
  `

  try {
    const signOutResult = await Promise.race([
      supabase.auth.signOut({ scope: 'local' }),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('หมดเวลารอการตอบกลับจากระบบออกจากระบบ')), signOutTimeoutMs)
      })
    ])

    const { error } = signOutResult
    if (error) throw error

    clearStoredAuthSession()
    await updateUI(null)
    window.location.reload()
  } catch (error) {
    clearStoredAuthSession()
    await updateUI(null)
    window.location.reload()
  } finally {
    logoutBtn.disabled = false
    logoutBtn.classList.remove('opacity-60', 'cursor-not-allowed')
    logoutBtn.innerHTML = originalMarkup
  }
})

// ==========================================
// 4. ดึงข้อมูลวิชา
// ==========================================
async function fetchCourses() {
  const courseNavList = document.getElementById('courseNavList')
  try {
    const { data, error } = await withTimeout(
      supabase.from(COURSES_TABLE).select('*').order('course_id', { ascending: true }),
      15000,
      'โหลดรายวิชาใช้เวลานานเกินไป'
    )
    if (error) throw error
    globalCourses = data || []
    courseNavList.innerHTML = ''

    globalCourses.forEach((course, index) => {
      const btn = document.createElement('button')
      btn.className = 'w-full flex items-center p-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-blue-50 hover:text-blue-700 transition group'
      const icon = index % 2 === 0 ? '📘' : '📗'
      btn.innerHTML = `
        <span class="text-xl w-6 text-center shrink-0 group-hover:scale-110 transition-transform">${icon}</span>
        <div class="sidebar-text ml-3 text-left whitespace-nowrap overflow-hidden flex flex-col gap-0.5 ${isSidebarExpanded ? '' : 'hidden opacity-0'}">
          <span class="font-bold truncate text-slate-700 group-hover:text-blue-700">${course.course_name}</span>
        </div>
      `
      btn.addEventListener('click', () => {
        window.loadContent('unit', course)
        if (!isSidebarExpanded) toggleSidebarBtn.click()
      })
      courseNavList.appendChild(btn)
    })

    if (document.getElementById('adminTableBody')) window.loadContent('admin')

  } catch (error) {
    courseNavList.innerHTML = `<p class="text-center text-xs text-red-400">โหลดรายวิชาล้มเหลว: ${error.message}</p>`
  }
}

// ==========================================
// 5. ระบบบันทึกโปรไฟล์
// ==========================================
window.saveProfile = async () => {
  const statusEl = document.getElementById('profileStatusMsg')
  const saveBtn = document.getElementById('profileSaveBtn')

  statusEl.textContent = '⏳ กำลังบันทึกข้อมูล...'
  statusEl.className = 'mt-3 text-sm font-bold text-blue-500'

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  const fullName = document.getElementById('profileFullName').value
  const schoolName = document.getElementById('profileSchool').value
  const originalBtnText = saveBtn?.textContent || '💾 บันทึกข้อมูลส่วนตัว'

  if (saveBtn) {
    saveBtn.disabled = true
    saveBtn.textContent = 'กำลังบันทึก...'
  }

  try {
    const { data: existingProfile, error: existingProfileError } = await withTimeout(
      supabase
        .from('users_profile')
        .select('id')
        .eq('id', session.user.id)
        .maybeSingle(),
      15000,
      'ตรวจสอบข้อมูลโปรไฟล์ใช้เวลานานเกินไป'
    )

    if (existingProfileError) throw existingProfileError

    const profileMutation = existingProfile
      ? supabase
        .from('users_profile')
        .update({
          full_name: fullName,
          school_name: schoolName
        })
        .eq('id', session.user.id)
        .select('id, full_name, school_name')
        .single()
      : supabase
        .from('users_profile')
        .insert({
          id: session.user.id,
          full_name: fullName,
          school_name: schoolName,
          role: 'student'
        })
        .select('id, full_name, school_name')
        .single()

    const { data: savedProfile, error } = await withTimeout(
      profileMutation,
      15000,
      'บันทึกข้อมูลโปรไฟล์ใช้เวลานานเกินไป'
    )

    if (error) throw error
    if (!savedProfile) throw new Error('ไม่พบข้อมูลที่ถูกบันทึกกลับจากระบบ')

    statusEl.textContent = '✅ บันทึกข้อมูลสำเร็จ!'
    statusEl.className = 'mt-3 text-sm font-bold text-green-500'
  } catch (error) {
    statusEl.textContent = '❌ เกิดข้อผิดพลาด: ' + error.message
    statusEl.className = 'mt-3 text-sm font-bold text-red-500'
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false
      saveBtn.textContent = originalBtnText
    }
  }
}

window.previewProfileImage = async () => {
  const fileInput = document.getElementById('profileImageInput')
  const preview = document.getElementById('profileImagePreview')
  const hintEl = document.getElementById('profileImageHint')
  const file = fileInput?.files?.[0]

  if (!file || !preview || !hintEl) return

  if (!PROFILE_IMAGE_ACCEPTED_TYPES.includes(file.type)) {
    hintEl.textContent = 'รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP'
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
    fileInput.value = ''
    return
  }

  if (file.size > PROFILE_IMAGE_MAX_SIZE_BYTES) {
    hintEl.textContent = `ไฟล์ใหญ่เกินไป กรุณาเลือกไฟล์ไม่เกิน ${formatFileSize(PROFILE_IMAGE_MAX_SIZE_BYTES)}`
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
    fileInput.value = ''
    return
  }

  try {
    hintEl.textContent = 'กำลังเตรียมรูปตัวอย่าง...'
    hintEl.className = 'text-xs text-blue-500 font-medium mt-2'

    const processedFile = await createProcessedProfileImage(file)
    const previewUrl = URL.createObjectURL(processedFile)

    setProfilePreviewSource(preview, previewUrl, 'ตัวอย่างรูปโปรไฟล์', '🧑‍🎓')
    hintEl.textContent = `ไฟล์พร้อมอัปโหลด: ${processedFile.name} (${formatFileSize(processedFile.size)}) ระบบจะครอปกึ่งกลางเป็น 512x512 px`
    hintEl.className = 'text-xs text-emerald-600 font-medium mt-2'
  } catch (error) {
    setProfilePreviewSource(preview, '', 'รูปโปรไฟล์', '🧑‍🎓')
    hintEl.textContent = `เตรียมรูปไม่สำเร็จ: ${error.message}`
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
    fileInput.value = ''
  }
}

window.uploadProfileImage = async () => {
  const fileInput = document.getElementById('profileImageInput')
  const hintEl = document.getElementById('profileImageHint')
  const uploadBtn = document.getElementById('profileImageUploadBtn')
  const file = fileInput?.files?.[0]

  if (!file || !hintEl || !uploadBtn) {
    alert('กรุณาเลือกรูปโปรไฟล์ก่อนครับ')
    return
  }

  if (!PROFILE_IMAGE_ACCEPTED_TYPES.includes(file.type)) {
    hintEl.textContent = 'รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP'
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
    return
  }

  if (file.size > PROFILE_IMAGE_MAX_SIZE_BYTES) {
    hintEl.textContent = `ไฟล์ใหญ่เกินไป กรุณาเลือกไฟล์ไม่เกิน ${formatFileSize(PROFILE_IMAGE_MAX_SIZE_BYTES)}`
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
    return
  }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  let previousAvatarStoragePath = ''
  const originalText = uploadBtn.textContent
  uploadBtn.disabled = true
  uploadBtn.textContent = 'กำลังอัปโหลด...'
  hintEl.textContent = 'กำลังอัปโหลดรูปโปรไฟล์...'
  hintEl.className = 'text-xs text-blue-500 font-medium mt-2'

  try {
    const processedFile = await createProcessedProfileImage(file)

    const { data: currentProfile, error: currentProfileError } = await withTimeout(
      supabase
        .from('users_profile')
        .select('avatar_url')
        .eq('id', session.user.id)
        .maybeSingle(),
      15000,
      'ดึงข้อมูลรูปโปรไฟล์เดิมใช้เวลานานเกินไป'
    )

    if (currentProfileError) throw currentProfileError

    previousAvatarStoragePath = getStoragePathFromPublicUrl(currentProfile?.avatar_url || '')

    const fileExtension = processedFile.name.split('.').pop()?.toLowerCase() || 'webp'
    const filePath = `${session.user.id}/avatar-${Date.now()}.${fileExtension}`

    const { error: uploadError } = await withTimeout(
      supabase
        .storage
        .from(PROFILE_IMAGE_BUCKET)
        .upload(filePath, processedFile, { upsert: true, contentType: processedFile.type }),
      15000,
      'อัปโหลดไฟล์ใช้เวลานานเกินไป'
    )

    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage
      .from(PROFILE_IMAGE_BUCKET)
      .getPublicUrl(filePath)

    const avatarUrl = publicUrlData.publicUrl

    const { error: profileUpdateError } = await withTimeout(
      supabase
        .from('users_profile')
        .update({
          avatar_url: avatarUrl
        })
        .eq('id', session.user.id),
      15000,
      'บันทึกลิงก์รูปโปรไฟล์ใช้เวลานานเกินไป'
    )

    if (profileUpdateError) throw profileUpdateError

    if (previousAvatarStoragePath && previousAvatarStoragePath !== filePath) {
      const { error: removeOldImageError } = await withTimeout(
        supabase
          .storage
          .from(PROFILE_IMAGE_BUCKET)
          .remove([previousAvatarStoragePath]),
        15000,
        'ลบไฟล์รูปเก่าใช้เวลานานเกินไป'
      )

      if (removeOldImageError) {
        hintEl.textContent = 'อัปโหลดรูปใหม่สำเร็จแล้ว แต่ยังลบไฟล์รูปเก่าไม่สำเร็จ'
        hintEl.className = 'text-xs text-amber-600 font-medium mt-2'
      }
    }

    if (!hintEl.textContent.includes('ลบไฟล์รูปเก่าไม่สำเร็จ')) {
      hintEl.textContent = 'อัปโหลดรูปโปรไฟล์สำเร็จแล้ว'
      hintEl.className = 'text-xs text-emerald-600 font-medium mt-2'
    }
    fileInput.value = ''

    const profilePreview = document.getElementById('profileImagePreview')
    if (profilePreview) {
      setProfilePreviewSource(profilePreview, avatarUrl, 'รูปโปรไฟล์', '🧑‍🎓')
    }

    const sidebarAvatar = document.getElementById('sidebarAvatar')
    if (sidebarAvatar) {
      sidebarAvatar.innerHTML = renderAvatarMarkup(avatarUrl, 'รูปโปรไฟล์', '👤')
      sidebarAvatar.classList.remove('text-slate-500')
      sidebarAvatar.classList.add('text-transparent')
    }
  } catch (error) {
    hintEl.textContent = `อัปโหลดไม่สำเร็จ: ${error.message}`
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
  } finally {
    uploadBtn.disabled = false
    uploadBtn.textContent = originalText
  }
}

window.deleteProfileImage = async () => {
  const deleteBtn = document.getElementById('profileImageDeleteBtn')
  const hintEl = document.getElementById('profileImageHint')
  const previewEl = document.getElementById('profileImagePreview')
  const fileInput = document.getElementById('profileImageInput')

  if (!deleteBtn || !hintEl || !previewEl || !fileInput) return
  if (!confirm('ต้องการลบรูปโปรไฟล์ใช่หรือไม่?')) return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  const originalText = deleteBtn.textContent
  deleteBtn.disabled = true
  deleteBtn.textContent = 'กำลังลบ...'
  hintEl.textContent = 'กำลังลบรูปโปรไฟล์...'
  hintEl.className = 'text-xs text-blue-500 font-medium mt-2'

  try {
    const { data: profileData, error: profileError } = await withTimeout(
      supabase
        .from('users_profile')
        .select('avatar_url')
        .eq('id', session.user.id)
        .maybeSingle(),
      15000,
      'ดึงข้อมูลรูปโปรไฟล์ใช้เวลานานเกินไป'
    )

    if (profileError) throw profileError

    const storagePath = getStoragePathFromPublicUrl(profileData?.avatar_url || '')
    if (storagePath) {
      const { error: removeError } = await withTimeout(
        supabase
          .storage
          .from(PROFILE_IMAGE_BUCKET)
          .remove([storagePath]),
        15000,
        'ลบไฟล์รูปโปรไฟล์ใช้เวลานานเกินไป'
      )

      if (removeError) throw removeError
    }

    const { error: updateError } = await withTimeout(
      supabase
        .from('users_profile')
        .update({ avatar_url: null })
        .eq('id', session.user.id),
      15000,
      'อัปเดตข้อมูลโปรไฟล์ใช้เวลานานเกินไป'
    )

    if (updateError) throw updateError

    previewEl.innerHTML = renderAvatarMarkup('', 'รูปโปรไฟล์', '🧑‍🎓')
    setProfilePreviewSource(previewEl, '', 'รูปโปรไฟล์', '🧑‍🎓')
    fileInput.value = ''
    hintEl.textContent = 'ลบรูปโปรไฟล์เรียบร้อยแล้ว'
    hintEl.className = 'text-xs text-emerald-600 font-medium mt-2'

    const sidebarAvatar = document.getElementById('sidebarAvatar')
    if (sidebarAvatar) {
      sidebarAvatar.innerHTML = renderAvatarMarkup('', 'รูปโปรไฟล์', '👤')
      sidebarAvatar.classList.add('text-slate-500')
      sidebarAvatar.classList.remove('text-transparent')
    }
  } catch (error) {
    hintEl.textContent = `ลบรูปไม่สำเร็จ: ${error.message}`
    hintEl.className = 'text-xs text-red-500 font-medium mt-2'
  } finally {
    deleteBtn.disabled = false
    deleteBtn.textContent = originalText
  }
}

// ==========================================
// 6. ระบบ Admin Panel
// ==========================================
window.openAdminModal = (isEdit = false, courseId = '') => {
  isEditMode = isEdit
  document.getElementById('adminModal').classList.remove('hidden')
  document.getElementById('adminFormStatus').textContent = ''

  if (isEdit) {
    document.getElementById('modalFormTitle').textContent = 'แก้ไขรายวิชา'
    document.getElementById('frm_id').readOnly = true
    const course = globalCourses.find(c => c.course_id === courseId)
    if (course) {
      document.getElementById('frm_id').value = course.course_id || ''
      document.getElementById('frm_name').value = course.course_name || ''
      document.getElementById('frm_instructor').value = course.instructor || course['C (instructor)'] || ''
      document.getElementById('frm_status').value = course.status || 'เปิดสอน'
      document.getElementById('frm_video').value = course.video_url || ''
      document.getElementById('frm_material').value = course.material_link || ''
      document.getElementById('frm_desc').value = course.description || ''
    }
  } else {
    document.getElementById('modalFormTitle').textContent = 'เพิ่มรายวิชาใหม่'
    document.getElementById('frm_id').readOnly = false
    document.getElementById('courseForm').reset()
  }
}

window.closeAdminModal = () => document.getElementById('adminModal').classList.add('hidden')

window.saveCourseData = async () => {
  const statusEl = document.getElementById('adminFormStatus')
  const spinner = document.getElementById('saveSpinner')

  const courseData = {
    course_id: document.getElementById('frm_id').value,
    course_name: document.getElementById('frm_name').value,
    instructor: document.getElementById('frm_instructor').value,
    status: document.getElementById('frm_status').value,
    video_url: document.getElementById('frm_video').value,
    material_link: document.getElementById('frm_material').value,
    description: document.getElementById('frm_desc').value
  }

  if (!courseData.course_id || !courseData.course_name) return
  spinner.classList.remove('hidden')
  statusEl.textContent = 'กำลังบันทึกรายวิชา...'
  statusEl.className = 'mt-4 text-center text-sm font-bold text-blue-500'

  try {
    const mutation = isEditMode
      ? supabase.from(COURSES_TABLE).update(courseData).eq('course_id', courseData.course_id)
      : supabase.from(COURSES_TABLE).insert(courseData)
    const { error } = await withTimeout(mutation, 15000, 'บันทึกรายวิชาใช้เวลานานเกินไป')
    if (error) throw error

    statusEl.textContent = 'บันทึกรายวิชาสำเร็จ'
    statusEl.className = 'mt-4 text-center text-sm font-bold text-green-500'
    closeAdminModal()
    fetchCourses()
  } catch (error) {
    statusEl.textContent = `บันทึกรายวิชาล้มเหลว: ${error.message}`
    statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
  } finally {
    spinner.classList.add('hidden')
  }
}

window.deleteCourse = async (courseId) => {
  if (!confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบวิชา ${courseId} ?`)) return
  try {
    const { error } = await withTimeout(
      supabase.from(COURSES_TABLE).delete().eq('course_id', courseId),
      15000,
      'ลบรายวิชาใช้เวลานานเกินไป'
    )
    if (error) throw error
    fetchCourses()
  } catch (error) { alert(`ลบข้อมูลล้มเหลว: ${error.message}`) }
}

// ==========================================
// 7. ระบบควบคุมหน้าจอฝั่งขวา (Renderer)
// ==========================================
window.loadContent = (type, data = null) => {
  destroyVideoPlayer()
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-5xl mx-auto w-full animate-fade-in'

  if (type === 'guidelines') {
    container.innerHTML = `
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl">📋</div>
        <h1 class="text-3xl font-extrabold text-slate-800">แนวปฏิบัติการเข้าอบรม</h1>
      </div>
      <div class="prose max-w-none text-slate-600 bg-white p-8 rounded-2xl shadow-sm border border-slate-100">
        <h3 class="text-lg font-bold text-slate-800 mb-4">ข้อตกลงในการใช้งานระบบ SolveEdu</h3>
        <ul class="space-y-2 list-disc pl-5">
          <li>กรุณาทำแบบทดสอบก่อนเรียนก่อนเริ่มศึกษาหน่วยการเรียน</li>
          <li>เมื่อศึกษาเนื้อหาและส่งภาระงานครบถ้วนแล้ว จึงจะสามารถทำแบบทดสอบหลังเรียนได้</li>
          <li>เกณฑ์การผ่านเพื่อรับเกียรติบัตร คือ ต้องได้คะแนนแบบทดสอบหลังเรียน 80% ขึ้นไป</li>
        </ul>
      </div>
    `
  }
  else if (type === 'profile') {
    container.innerHTML = `
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 bg-sky-100 text-sky-600 rounded-xl flex items-center justify-center text-2xl">👤</div>
        <h1 class="text-3xl font-extrabold text-slate-800">จัดการโปรไฟล์ส่วนตัว</h1>
      </div>
      <div class="bg-white p-8 md:p-10 rounded-2xl shadow-sm border border-slate-100">
        <div class="flex items-center gap-6 mb-8 pb-8 border-b border-slate-100">
          <div id="profileImagePreview" class="w-24 h-24 bg-slate-200 rounded-full flex items-center justify-center text-4xl overflow-hidden shadow-inner text-slate-500">🧑‍🎓</div>
          <div>
            <p class="text-sm font-bold text-slate-700">รูปภาพโปรไฟล์</p>
            <p class="text-xs text-slate-400">อัปโหลดได้เฉพาะ JPG, PNG, WEBP ขนาดไม่เกิน 2 MB และระบบจะครอปเป็น 512x512 px อัตโนมัติ</p>
            <div class="mt-3 flex flex-col sm:flex-row gap-3">
              <input type="file" id="profileImageInput" accept="image/jpeg,image/png,image/webp" onchange="previewProfileImage()" class="block text-xs text-slate-500 file:mr-2 file:py-2 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-sky-50 file:text-sky-700 hover:file:bg-sky-100 cursor-pointer">
              <button type="button" id="profileImageUploadBtn" onclick="uploadProfileImage()" class="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-bold transition shadow-sm">อัปโหลดรูป</button>
              <button type="button" id="profileImageDeleteBtn" onclick="deleteProfileImage()" class="px-4 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 text-sm font-bold transition border border-rose-200">ลบรูป</button>
            </div>
            <p id="profileImageHint" class="text-xs text-slate-400 mt-2">แนะนำภาพที่มีใบหน้าอยู่กึ่งกลาง ระบบจะครอปอัตโนมัติเป็นสี่เหลี่ยม</p>
          </div>
        </div>
        <form class="space-y-5 max-w-2xl">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div><label class="block text-sm font-bold text-slate-600 mb-1">ชื่อ - นามสกุล (ภาษาไทย)</label><input type="text" id="profileFullName" class="w-full p-3 border border-slate-200 rounded-xl outline-none focus:border-blue-500" placeholder="ระบุชื่อจริง-นามสกุล"></div>
          </div>
          <div>
            <label class="block text-sm font-bold text-slate-600 mb-1">อีเมล (บัญชีเข้าสู่ระบบ)</label>
            <input type="email" id="profileEmailDisplay" class="w-full p-3 border border-slate-200 rounded-xl bg-slate-50 text-slate-400 cursor-not-allowed" disabled>
          </div>
          <div><label class="block text-sm font-bold text-slate-600 mb-1">โรงเรียน / หน่วยงาน</label><input type="text" id="profileSchool" class="w-full p-3 border border-slate-200 rounded-xl outline-none focus:border-blue-500" placeholder="ระบุชื่อโรงเรียน หรือ สำนักงานเขตฯ"></div>
          <div class="pt-4">
            <button type="button" id="profileSaveBtn" onclick="saveProfile()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-8 rounded-xl transition shadow-md w-full md:w-auto disabled:opacity-60 disabled:cursor-not-allowed">💾 บันทึกข้อมูลส่วนตัว</button>
            <p id="profileStatusMsg" class="mt-3 text-sm font-bold"></p>
          </div>
        </form>
      </div>
    `
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        document.getElementById('profileEmailDisplay').value = session.user.email
        const { data } = await supabase.from('users_profile').select('*').eq('id', session.user.id).single()
        const avatarUrl = getProfileAvatarUrl(session, data)

        setProfilePreviewSource(document.getElementById('profileImagePreview'), avatarUrl, 'รูปโปรไฟล์', '🧑‍🎓')

        if (data) {
          document.getElementById('profileFullName').value = data.full_name || ''
          document.getElementById('profileSchool').value = data.school_name || ''
        }
      }
    })
  }
  else if (type === 'unit' && data) {
    const hasVideoQuiz = Boolean(data.has_video_quiz)
    const videoHTML = data.video_url
      ? `<div class="aspect-video bg-slate-900 rounded-xl overflow-hidden mb-8 shadow-lg ring-1 ring-slate-200/50">
          <div id="ytPlayerContainer" class="w-full h-full"></div>
         </div>
         ${hasVideoQuiz ? '<p class="text-xs text-amber-600 font-bold mb-6 flex items-center gap-1">⚠️ วิดีโอนี้มีคำถามระหว่างการเรียน — ไม่สามารถกรอวิดีโอข้ามได้</p>' : ''}`
      : ''
    const materialHTML = data.material_link
      ? `<a href="${data.material_link}" target="_blank" class="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white px-6 py-3.5 rounded-xl font-bold transition shadow-sm">📄 เปิดเอกสารประกอบการเรียน</a>`
      : ''

    container.innerHTML = `
      <div class="mb-6">
        <span class="px-3 py-1 bg-blue-100 text-blue-700 text-[10px] font-bold rounded-full mb-3 inline-block tracking-wider uppercase">${data.course_id}</span>
        <h1 class="text-3xl md:text-4xl font-extrabold text-slate-800 leading-tight">${data.course_name}</h1>
        <p class="text-slate-500 mt-3 font-medium flex items-center gap-2"><span class="text-lg">👨‍🏫</span> ผู้สอน: <span class="text-slate-700">${data.instructor || 'ไม่ระบุ'}</span></p>
      </div>
      ${videoHTML}
      <div class="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 mb-6 relative overflow-hidden">
        <div class="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
        <h3 class="font-bold text-slate-800 mb-3 text-lg">คำอธิบายเนื้อหา</h3>
        <p class="text-slate-600 leading-relaxed whitespace-pre-wrap">${data.description || 'ไม่มีคำอธิบายเพิ่มเติม'}</p>
      </div>
      <div class="flex gap-4">${materialHTML}</div>
    `
    contentArea.appendChild(container)
    if (data.video_url) initVideoPlayer(data.video_url, data.course_id, hasVideoQuiz)
    return
  }
  else if (type === 'admin') {
    let tableRows = globalCourses.map(c => `
      <tr class="hover:bg-slate-50 border-b border-slate-100">
        <td class="p-4 font-bold text-slate-700">${c.course_id}</td>
        <td class="p-4 font-medium">${c.course_name}</td>
        <td class="p-4 text-center"><span class="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">${c.status}</span></td>
        <td class="p-4 text-center">
          <button onclick="toggleVideoQuiz('${c.course_id}', ${!c.has_video_quiz})"
            class="px-3 py-1.5 rounded text-xs font-bold transition ${c.has_video_quiz ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}">
            ${c.has_video_quiz ? '🎬 เปิดอยู่' : '— ปิดอยู่'}
          </button>
        </td>
        <td class="p-4">
          <div class="flex gap-2 justify-end flex-wrap">
            <button onclick="loadContent('videoAdmin', ${JSON.stringify(c).replace(/"/g, '&quot;')})" class="px-3 py-1.5 bg-amber-50 text-amber-700 hover:bg-amber-100 rounded text-xs font-bold">คำถามวิดีโอ</button>
            <button onclick="openAdminModal(true, '${c.course_id}')" class="px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded text-xs font-bold">แก้ไข</button>
            <button onclick="deleteCourse('${c.course_id}')" class="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded text-xs font-bold">ลบ</button>
          </div>
        </td>
      </tr>
    `).join('')

    container.innerHTML = `
      <div class="flex items-center justify-between mb-8">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center text-2xl">⚙️</div>
          <h1 class="text-3xl font-extrabold text-slate-800">จัดการรายวิชา</h1>
        </div>
        <button onclick="openAdminModal(false)" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold shadow-md flex items-center gap-2">
          ➕ เพิ่มรายวิชาใหม่
        </button>
      </div>
      <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <table class="w-full text-left text-sm text-slate-600">
          <thead class="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
            <tr>
              <th class="p-4">รหัสวิชา</th>
              <th class="p-4">ชื่อวิชา</th>
              <th class="p-4 text-center">สถานะ</th>
              <th class="p-4 text-center">คำถามวิดีโอ</th>
              <th class="p-4 text-right">การจัดการ</th>
            </tr>
          </thead>
          <tbody id="adminTableBody">${tableRows}</tbody>
        </table>
      </div>
    `
  }
  else if (type === 'videoAdmin' && data) {
    renderVideoAdminPage(data)
    return
  }
  // --- 8. หน้าส่งภาระงาน (ระบบจริง) แยกออกมาแล้ว ---
  else if (type === 'submission') {
    container.innerHTML = `
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center text-2xl">📤</div>
        <h1 class="text-3xl font-extrabold text-slate-800">ส่งภาระงาน</h1>
      </div>
      <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <table class="w-full text-left text-sm text-slate-600">
          <thead class="bg-slate-50/80 text-slate-700 font-bold border-b border-slate-200">
            <tr>
              <th class="p-5">รหัสวิชา</th>
              <th class="p-5">ชื่อวิชา (ภาระงาน)</th>
              <th class="p-5 text-center">สถานะ</th>
              <th class="p-5 text-center">ดำเนินการอัปโหลด</th>
            </tr>
          </thead>
          <tbody id="submissionTableBody" class="divide-y divide-slate-100">
            <tr><td colspan="4" class="p-5 text-center text-slate-400">⏳ กำลังโหลดข้อมูล...</td></tr>
          </tbody>
        </table>
      </div>
    `

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return

      const { data: logs } = await supabase
        .from('course_logs')
        .select('course_id, file_url')
        .eq('user_id', session.user.id)

      const tbody = document.getElementById('submissionTableBody')
      tbody.innerHTML = ''

      globalCourses.forEach(c => {
        const submittedLog = logs ? logs.find(l => l.course_id === c.course_id && l.file_url) : null

        let statusBadge = `<span class="px-3 py-1.5 bg-rose-50 text-rose-600 rounded-lg text-xs font-bold border border-rose-100">ยังไม่ส่ง</span>`
        let actionHTML = `
          <div class="flex flex-col items-center justify-center gap-2">
            <input type="file" id="file_${c.course_id}" class="text-xs w-48 text-slate-500 file:mr-2 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer">
            <button onclick="uploadWork('${c.course_id}')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-xs font-bold transition shadow-sm w-full">อัปโหลดงาน</button>
            <p id="status_${c.course_id}" class="text-[10px] text-blue-500 font-bold hidden">กำลังอัปโหลด...</p>
          </div>
        `

        if (submittedLog) {
          statusBadge = `<span class="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-bold border border-emerald-100">ส่งแล้ว</span>`
          actionHTML = `<a href="${submittedLog.file_url}" target="_blank" class="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 hover:underline font-bold text-xs"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg> ดูไฟล์ที่ส่งไป</a>`
        }

        tbody.innerHTML += `
          <tr class="hover:bg-slate-50/50 transition">
            <td class="p-5 font-bold text-slate-800">${c.course_id}</td>
            <td class="p-5 font-medium text-slate-600">${c.course_name}</td>
            <td class="p-5 text-center">${statusBadge}</td>
            <td class="p-5 text-center">${actionHTML}</td>
          </tr>
        `
      })
    })
  }
  // --- หน้าอื่นๆ ที่ยังไม่ได้ทำ (เหลือแค่ก่อนเรียน-หลังเรียน) ---
  else if (type === 'pretest' || type === 'posttest') {
    loadQuizPage(type)
    return
  }
  else if (type === 'quizAdmin') {
    renderQuizAdminPage()
    return
  }
  else if (type === 'approvals') {
    renderApprovalsPage()
    return
  }
  else if (type === 'staffDashboard') {
    renderStaffDashboard()
    return
  }
  else if (type === 'mentorDashboard') {
    renderMentorDashboard()
    return
  }
  else if (type === 'mentorTrainees') {
    renderMentorTrainees()
    return
  }
  else if (type === 'mentorReview') {
    renderMentorReview()
    return
  }

  contentArea.appendChild(container)
}

// ==========================================
// 9. ฟังก์ชันอัปโหลดไฟล์ (Supabase Storage)
// ==========================================
window.uploadWork = async (courseId) => {
  const fileInput = document.getElementById(`file_${courseId}`)
  const file = fileInput.files[0]
  const statusMsg = document.getElementById(`status_${courseId}`)

  if (!file) {
    alert('กรุณาเลือกไฟล์ก่อนกดอัปโหลดครับ')
    return
  }

  fileInput.classList.add('hidden')
  statusMsg.classList.remove('hidden')

  try {
    const { data: { session } } = await supabase.auth.getSession()

    // ตั้งชื่อไฟล์: user_id + course_id + timestamp 
    const fileExt = file.name.split('.').pop()
    const fileName = `${session.user.id}_${courseId}_${Date.now()}.${fileExt}`

    // 1. อัปโหลดไฟล์
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('submissions')
      .upload(fileName, file)

    if (uploadError) throw uploadError

    // 2. ขอ Public URL
    const { data: publicUrlData } = supabase.storage
      .from('submissions')
      .getPublicUrl(fileName)

    const fileUrl = publicUrlData.publicUrl

    // 3. บันทึกลิงก์ลงฐานข้อมูล
    const { error: dbError } = await supabase.from('course_logs').insert([
      { user_id: session.user.id, course_id: courseId, file_url: fileUrl }
    ])

    if (dbError) throw dbError

    alert('อัปโหลดภาระงานสำเร็จแล้วครับ! 🎉')
    window.loadContent('submission')

  } catch (error) {
    alert('เกิดข้อผิดพลาดในการอัปโหลด: ' + error.message)
    fileInput.classList.remove('hidden')
    statusMsg.classList.add('hidden')
  }
}

// ==========================================
// QUIZ SYSTEM
// ==========================================

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---- Admin: จัดการคำถาม ----

async function renderQuizAdminPage() {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-5xl mx-auto w-full animate-fade-in'

  const { data: questions, error } = await supabase
    .from(QUIZ_QUESTIONS_TABLE).select('*').order('created_at', { ascending: true })

  if (error) {
    container.innerHTML = `<p class="text-red-500 text-center py-12">โหลดคำถามไม่สำเร็จ: ${error.message}</p>`
    contentArea.appendChild(container)
    return
  }

  const typeLabel = { mcq: 'ปรนัย', fill: 'เติมคำ', matching: 'จับคู่', dragdrop: 'เรียงลำดับ' }
  const typeBadge = { mcq: 'bg-blue-100 text-blue-700', fill: 'bg-violet-100 text-violet-700', matching: 'bg-amber-100 text-amber-700', dragdrop: 'bg-emerald-100 text-emerald-700' }
  const quizTypeLabel = { pretest: 'ก่อนเรียน', posttest: 'หลังเรียน', both: 'ทั้งคู่' }

  const rows = (questions || []).map(q => `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4 max-w-xs"><p class="text-sm font-medium text-slate-800 line-clamp-2">${escapeHtml(q.question)}</p></td>
      <td class="p-4"><span class="px-2 py-1 ${typeBadge[q.type] || 'bg-slate-100 text-slate-600'} text-xs rounded-full font-bold">${typeLabel[q.type] || q.type}</span></td>
      <td class="p-4 text-center"><span class="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-full">${quizTypeLabel[q.quiz_type] || q.quiz_type}</span></td>
      <td class="p-4 text-center text-sm font-bold text-slate-600">${q.points || 1}</td>
      <td class="p-4"><div class="flex gap-2 justify-end">
        <button onclick="editQuizQuestion('${q.id}')" class="px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded text-xs font-bold">แก้ไข</button>
        <button onclick="deleteQuizQuestion('${q.id}')" class="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded text-xs font-bold">ลบ</button>
      </div></td>
    </tr>
  `).join('')

  container.innerHTML = `
    <div class="flex items-center justify-between mb-8">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 bg-violet-100 text-violet-600 rounded-xl flex items-center justify-center text-2xl">📝</div>
        <div>
          <h1 class="text-3xl font-extrabold text-slate-800">จัดการคำถาม</h1>
          <p class="text-sm text-slate-500">${(questions || []).length} คำถามทั้งหมด</p>
        </div>
      </div>
      <button onclick="openQuizModal()" class="bg-violet-600 hover:bg-violet-700 text-white px-6 py-3 rounded-xl font-bold shadow-md flex items-center gap-2 transition">➕ เพิ่มคำถาม</button>
    </div>
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      ${(questions || []).length === 0
      ? '<p class="text-center text-slate-400 py-16">ยังไม่มีคำถาม กด "เพิ่มคำถาม" เพื่อเริ่มต้น</p>'
      : `<table class="w-full text-left text-sm text-slate-600">
            <thead class="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
              <tr><th class="p-4">คำถาม</th><th class="p-4">รูปแบบ</th><th class="p-4 text-center">ใช้ใน</th><th class="p-4 text-center">คะแนน</th><th class="p-4 text-right">การจัดการ</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>
  `
  contentArea.appendChild(container)
}

window.openQuizModal = (isEdit = false) => {
  if (!isEdit) {
    editingQuizId = null
    document.getElementById('quizForm').reset()
    document.getElementById('quizModalTitle').textContent = 'เพิ่มคำถาม'
    document.getElementById('quizFormStatus').textContent = ''
    const r = document.querySelector('input[name="qz_type"][value="pretest"]')
    if (r) r.checked = true
    document.getElementById('qz_qtype').value = 'mcq'
    quizMatchingPairCount = 3
    quizDragDropItemCount = 3
    renderQuizFormFields()
  }
  document.getElementById('quizModal').classList.remove('hidden')
}

window.closeQuizModal = () => document.getElementById('quizModal').classList.add('hidden')

window.renderQuizFormFields = () => {
  const type = document.getElementById('qz_qtype').value
  const container = document.getElementById('quizDynamicFields')

  if (type === 'mcq') {
    container.innerHTML = `
      <div>
        <label class="block text-xs font-bold text-slate-500 mb-2">ตัวเลือก (☑ ติ๊กข้อที่ถูกต้อง — เลือกได้มากกว่า 1 ข้อ)</label>
        ${['A', 'B', 'C', 'D'].map(l => `
          <div class="flex items-center gap-2 mb-2">
            <input type="checkbox" name="mcq_correct" value="${l}" class="accent-violet-600 shrink-0 w-4 h-4 rounded">
            <span class="text-xs font-bold text-slate-500 w-5">${l}.</span>
            <input type="text" id="opt_${l}" placeholder="ตัวเลือก ${l}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
          </div>`).join('')}
      </div>`
  } else if (type === 'fill') {
    container.innerHTML = `
      <div>
        <label class="block text-xs font-bold text-slate-500 mb-1">คำตอบที่ถูกต้อง *</label>
        <input type="text" id="fill_answer" class="w-full p-2 border border-slate-200 rounded-lg outline-none focus:border-violet-500" placeholder="พิมพ์คำตอบ">
      </div>`
  } else if (type === 'matching') {
    quizMatchingPairCount = 3
    container.innerHTML = `
      <div>
        <label class="block text-xs font-bold text-slate-500 mb-2">คู่ที่ถูกต้อง (อย่างน้อย 2 คู่)</label>
        <div id="matchingPairs" class="space-y-2">
          ${[1, 2, 3].map(i => `
            <div class="flex gap-2 items-center">
              <input type="text" placeholder="ด้านซ้าย ${i}" id="match_left_${i}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
              <span class="text-slate-400 font-bold">↔</span>
              <input type="text" placeholder="ด้านขวา ${i}" id="match_right_${i}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
            </div>`).join('')}
        </div>
        <button type="button" onclick="addQuizMatchingPair()" class="mt-2 text-xs text-violet-600 font-bold hover:underline">+ เพิ่มคู่</button>
      </div>`
  } else if (type === 'dragdrop') {
    quizDragDropItemCount = 3
    container.innerHTML = `
      <div>
        <label class="block text-xs font-bold text-slate-500 mb-2">รายการตามลำดับที่ถูกต้อง (อย่างน้อย 2 รายการ)</label>
        <div id="dragdropItems" class="space-y-2">
          ${[1, 2, 3].map(i => `
            <div class="flex gap-2 items-center">
              <span class="text-xs text-slate-400 w-5 shrink-0">${i}.</span>
              <input type="text" placeholder="รายการที่ ${i}" id="dd_item_${i}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
            </div>`).join('')}
        </div>
        <button type="button" onclick="addQuizDragDropItem()" class="mt-2 text-xs text-violet-600 font-bold hover:underline">+ เพิ่มรายการ</button>
      </div>`
  }
}

window.addQuizMatchingPair = () => {
  quizMatchingPairCount++
  const div = document.createElement('div')
  div.className = 'flex gap-2 items-center'
  div.innerHTML = `
    <input type="text" placeholder="ด้านซ้าย ${quizMatchingPairCount}" id="match_left_${quizMatchingPairCount}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
    <span class="text-slate-400 font-bold">↔</span>
    <input type="text" placeholder="ด้านขวา ${quizMatchingPairCount}" id="match_right_${quizMatchingPairCount}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">`
  document.getElementById('matchingPairs').appendChild(div)
}

window.addQuizDragDropItem = () => {
  quizDragDropItemCount++
  const div = document.createElement('div')
  div.className = 'flex gap-2 items-center'
  div.innerHTML = `
    <span class="text-xs text-slate-400 w-5 shrink-0">${quizDragDropItemCount}.</span>
    <input type="text" placeholder="รายการที่ ${quizDragDropItemCount}" id="dd_item_${quizDragDropItemCount}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">`
  document.getElementById('dragdropItems').appendChild(div)
}

window.editQuizQuestion = async (id) => {
  const { data: q, error } = await supabase.from(QUIZ_QUESTIONS_TABLE).select('*').eq('id', id).single()
  if (error || !q) { alert('ไม่พบคำถาม'); return }

  editingQuizId = id
  document.getElementById('quizModalTitle').textContent = 'แก้ไขคำถาม'
  document.getElementById('quizFormStatus').textContent = ''

  const typeRadio = document.querySelector(`input[name="qz_type"][value="${q.quiz_type}"]`)
  if (typeRadio) typeRadio.checked = true
  document.getElementById('qz_qtype').value = q.type
  renderQuizFormFields()
  document.getElementById('qz_question').value = q.question
  document.getElementById('qz_points').value = q.points || 1

  if (q.type === 'mcq') {
    const opts = q.options || []
      ;['A', 'B', 'C', 'D'].forEach((l, i) => {
        const el = document.getElementById(`opt_${l}`)
        if (el) el.value = opts[i] || ''
      })
    // answer อาจเป็น array หรือ string เดิม
    const correctAnswers = Array.isArray(q.answer) ? q.answer : (q.answer ? [q.answer] : [])
    document.querySelectorAll('input[name="mcq_correct"]').forEach(cb => {
      const optVal = document.getElementById(`opt_${cb.value}`)?.value.trim()
      cb.checked = correctAnswers.includes(optVal)
    })
  } else if (q.type === 'fill') {
    const el = document.getElementById('fill_answer')
    if (el) el.value = q.answer || ''
  } else if (q.type === 'matching') {
    const pairs = q.options || []
    quizMatchingPairCount = pairs.length
    const c = document.getElementById('matchingPairs')
    if (c) c.innerHTML = pairs.map((p, i) => `
      <div class="flex gap-2 items-center">
        <input type="text" value="${escapeHtml(p.left)}" id="match_left_${i + 1}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
        <span class="text-slate-400 font-bold">↔</span>
        <input type="text" value="${escapeHtml(p.right)}" id="match_right_${i + 1}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
      </div>`).join('')
  } else if (q.type === 'dragdrop') {
    const items = q.options || []
    quizDragDropItemCount = items.length
    const c = document.getElementById('dragdropItems')
    if (c) c.innerHTML = items.map((item, i) => `
      <div class="flex gap-2 items-center">
        <span class="text-xs text-slate-400 w-5 shrink-0">${i + 1}.</span>
        <input type="text" value="${escapeHtml(item)}" id="dd_item_${i + 1}" class="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-violet-500">
      </div>`).join('')
  }
  document.getElementById('quizModal').classList.remove('hidden')
}

window.saveQuizQuestion = async () => {
  const statusEl = document.getElementById('quizFormStatus')
  const quizType = document.querySelector('input[name="qz_type"]:checked')?.value
  const qType = document.getElementById('qz_qtype').value
  const question = document.getElementById('qz_question').value.trim()
  const points = parseInt(document.getElementById('qz_points').value) || 1

  if (!question) {
    statusEl.textContent = 'กรุณากรอกโจทย์คำถาม'
    statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
    return
  }

  let options = null, answer = null

  if (qType === 'mcq') {
    const optMap = {}
      ;['A', 'B', 'C', 'D'].forEach(l => {
        const v = document.getElementById(`opt_${l}`)?.value.trim()
        if (v) optMap[l] = v
      })
    const checkedLabels = [...document.querySelectorAll('input[name="mcq_correct"]:checked')].map(cb => cb.value)
    options = ['A', 'B', 'C', 'D'].map(l => optMap[l]).filter(Boolean)
    answer = checkedLabels.map(l => optMap[l]).filter(Boolean)
    if (options.length < 2 || answer.length === 0) {
      statusEl.textContent = 'กรุณากรอกตัวเลือกอย่างน้อย 2 ข้อ และเลือกคำตอบที่ถูกต้องอย่างน้อย 1 ข้อ'
      statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
      return
    }
    // ถ้ามีคำตอบเดียวให้เก็บเป็น string เพื่อ backward compat
    if (answer.length === 1) answer = answer[0]
  } else if (qType === 'fill') {
    answer = document.getElementById('fill_answer')?.value.trim()
    if (!answer) {
      statusEl.textContent = 'กรุณากรอกคำตอบที่ถูกต้อง'
      statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
      return
    }
  } else if (qType === 'matching') {
    const pairs = []
    for (let i = 1; i <= quizMatchingPairCount; i++) {
      const left = document.getElementById(`match_left_${i}`)?.value.trim()
      const right = document.getElementById(`match_right_${i}`)?.value.trim()
      if (left && right) pairs.push({ left, right })
    }
    if (pairs.length < 2) {
      statusEl.textContent = 'กรุณากรอกคู่อย่างน้อย 2 คู่'
      statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
      return
    }
    options = pairs
    answer = pairs.reduce((acc, p) => { acc[p.left] = p.right; return acc }, {})
  } else if (qType === 'dragdrop') {
    const items = []
    for (let i = 1; i <= quizDragDropItemCount; i++) {
      const v = document.getElementById(`dd_item_${i}`)?.value.trim()
      if (v) items.push(v)
    }
    if (items.length < 2) {
      statusEl.textContent = 'กรุณากรอกรายการอย่างน้อย 2 รายการ'
      statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
      return
    }
    options = items
    answer = items
  }

  statusEl.textContent = 'กำลังบันทึก...'
  statusEl.className = 'mt-4 text-center text-sm font-bold text-blue-500'

  try {
    const payload = { quiz_type: quizType, type: qType, question, options, answer, points }
    const mutation = editingQuizId
      ? supabase.from(QUIZ_QUESTIONS_TABLE).update(payload).eq('id', editingQuizId)
      : supabase.from(QUIZ_QUESTIONS_TABLE).insert(payload)
    const { error } = await mutation
    if (error) throw error
    closeQuizModal()
    await renderQuizAdminPage()
  } catch (err) {
    statusEl.textContent = `บันทึกไม่สำเร็จ: ${err.message}`
    statusEl.className = 'mt-4 text-center text-sm font-bold text-red-500'
  }
}

window.deleteQuizQuestion = async (id) => {
  if (!confirm('ต้องการลบคำถามนี้ใช่หรือไม่?')) return
  const { error } = await supabase.from(QUIZ_QUESTIONS_TABLE).delete().eq('id', id)
  if (error) { alert('ลบไม่สำเร็จ: ' + error.message); return }
  await renderQuizAdminPage()
}

// ---- Student: ทำแบบทดสอบ ----

async function loadQuizPage(quizType) {
  contentArea.innerHTML = '<div class="text-center py-20 text-slate-400 text-lg">⏳ กำลังโหลดคำถาม...</div>'

  const filter = quizType === 'pretest' ? ['pretest', 'both'] : ['posttest', 'both']
  const { data: questions, error } = await supabase
    .from(QUIZ_QUESTIONS_TABLE).select('*').in('quiz_type', filter)

  if (error) {
    contentArea.innerHTML = `<div class="text-center text-red-500 py-20">โหลดคำถามไม่สำเร็จ: ${error.message}</div>`
    return
  }
  if (!questions || questions.length === 0) {
    contentArea.innerHTML = `<div class="text-center py-20 text-slate-400">ยังไม่มีคำถามในระบบ กรุณาติดต่อผู้ดูแล</div>`
    return
  }

  currentQuizQuestions = shuffleArray([...questions]).map(q =>
    q.type === 'mcq' && Array.isArray(q.options)
      ? { ...q, options: shuffleArray([...q.options]) }
      : q
  )
  renderQuizPage(quizType)
}

function renderQuizPage(quizType) {
  const label = quizType === 'pretest' ? 'ก่อนเรียน' : 'หลังเรียน'
  const icon = quizType === 'pretest' ? '📝' : '🏆'
  const totalPoints = currentQuizQuestions.reduce((s, q) => s + (q.points || 1), 0)

  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-3xl mx-auto w-full animate-fade-in pb-10'
  container.innerHTML = `
    <div class="flex items-center gap-3 mb-8">
      <div class="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl">${icon}</div>
      <div>
        <h1 class="text-3xl font-extrabold text-slate-800">แบบทดสอบ${label}</h1>
        <p class="text-sm text-slate-500">${currentQuizQuestions.length} ข้อ | คะแนนเต็ม ${totalPoints} คะแนน</p>
      </div>
    </div>
    <div class="space-y-6">
      ${currentQuizQuestions.map((q, i) => renderStudentQuestion(q, i)).join('')}
    </div>
    <div class="mt-10 text-center">
      <button onclick="submitQuiz('${quizType}')" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-16 rounded-2xl text-lg shadow-lg transition">ส่งคำตอบ</button>
    </div>
    <div id="quizResultArea" class="mt-10"></div>
  `
  contentArea.appendChild(container)
  currentQuizQuestions.forEach(q => { if (q.type === 'dragdrop') initStudentDragDrop(q.id) })
}

function renderStudentQuestion(q, index) {
  const typeLabel = { mcq: 'ปรนัย', fill: 'เติมคำ', matching: 'จับคู่', dragdrop: 'เรียงลำดับ' }
  let inputHTML = ''

  if (q.type === 'mcq') {
    const isMulti = Array.isArray(q.answer)
    const inputType = isMulti ? 'checkbox' : 'radio'
    const hint = isMulti ? `<p class="text-xs text-blue-500 mt-2 font-medium">☑ เลือกได้มากกว่า 1 ข้อ</p>` : ''
    inputHTML = `<div class="space-y-2 mt-4">
      ${(q.options || []).map(opt => `
        <label class="flex items-center gap-3 p-3.5 border border-slate-200 rounded-xl cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition">
          <input type="${inputType}" name="q_${q.id}" value="${escapeHtml(opt)}" class="accent-blue-600 shrink-0 w-4 h-4">
          <span class="text-sm text-slate-700">${escapeHtml(opt)}</span>
        </label>`).join('')}
      ${hint}
    </div>`
  } else if (q.type === 'fill') {
    inputHTML = `<div class="mt-4">
      <input type="text" id="ans_${q.id}" placeholder="พิมพ์คำตอบที่นี่..."
        class="w-full p-3 border border-slate-200 rounded-xl outline-none focus:border-blue-500 text-sm">
    </div>`
  } else if (q.type === 'matching') {
    const pairs = q.options || []
    const shuffledRight = shuffleArray(pairs.map(p => p.right))
    inputHTML = `<div class="mt-4 space-y-3">
      ${pairs.map((p, pi) => `
        <div class="flex items-center gap-3">
          <div class="flex-1 p-3 bg-blue-50 border border-blue-100 rounded-xl text-sm font-medium text-blue-800">${escapeHtml(p.left)}</div>
          <span class="text-slate-400 font-bold shrink-0">→</span>
          <select id="match_${q.id}_${pi}" class="flex-1 p-3 border border-slate-200 rounded-xl text-sm outline-none focus:border-blue-500 bg-white">
            <option value="">-- เลือก --</option>
            ${shuffledRight.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
          </select>
        </div>`).join('')}
    </div>`
  } else if (q.type === 'dragdrop') {
    const shuffledItems = shuffleArray([...(q.options || [])])
    inputHTML = `<div class="mt-4">
      <p class="text-xs text-slate-400 mb-3">↕ ลากเพื่อเรียงลำดับที่ถูกต้อง</p>
      <div id="dd_list_${q.id}" class="space-y-2">
        ${shuffledItems.map(item => `
          <div draggable="true" class="dd-item flex items-center gap-3 p-3.5 bg-white border border-slate-200 rounded-xl cursor-grab select-none shadow-sm hover:border-blue-300 transition" data-value="${escapeHtml(item)}">
            <span class="text-slate-300 text-lg leading-none">⋮⋮</span>
            <span class="text-sm font-medium text-slate-700">${escapeHtml(item)}</span>
          </div>`).join('')}
      </div>
    </div>`
  }

  return `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 hover:shadow-md transition">
      <div class="flex items-start gap-4">
        <span class="shrink-0 w-9 h-9 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">${index + 1}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full font-bold uppercase tracking-wide">${typeLabel[q.type] || q.type}</span>
            <span class="text-[10px] text-slate-400">${q.points || 1} คะแนน</span>
          </div>
          <p class="text-slate-800 font-medium leading-relaxed">${escapeHtml(q.question)}</p>
          ${inputHTML}
        </div>
      </div>
    </div>`
}

function initStudentDragDrop(qId) {
  const list = document.getElementById(`dd_list_${qId}`)
  if (!list) return
  let draggedEl = null
  list.addEventListener('dragstart', e => {
    draggedEl = e.target.closest('.dd-item')
    window.setTimeout(() => draggedEl?.classList.add('opacity-40'), 0)
  })
  list.addEventListener('dragend', () => {
    draggedEl?.classList.remove('opacity-40')
    draggedEl = null
  })
  list.addEventListener('dragover', e => {
    e.preventDefault()
    const target = e.target.closest('.dd-item')
    if (!target || !draggedEl || target === draggedEl) return
    const rect = target.getBoundingClientRect()
    if (e.clientY < rect.top + rect.height / 2) list.insertBefore(draggedEl, target)
    else list.insertBefore(draggedEl, target.nextSibling)
  })
}

window.submitQuiz = async (quizType) => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  let score = 0
  const total = currentQuizQuestions.reduce((s, q) => s + (q.points || 1), 0)
  const userAnswers = {}

  currentQuizQuestions.forEach(q => {
    const pts = q.points || 1
    if (q.type === 'mcq') {
      const isMulti = Array.isArray(q.answer)
      if (isMulti) {
        const selected = [...document.querySelectorAll(`input[name="q_${q.id}"]:checked`)].map(el => el.value)
        userAnswers[q.id] = selected
        const correctSet = new Set(q.answer)
        const correct = selected.length === correctSet.size && selected.every(s => correctSet.has(s))
        if (correct) score += pts
      } else {
        const sel = document.querySelector(`input[name="q_${q.id}"]:checked`)?.value
        userAnswers[q.id] = sel || null
        if (sel === q.answer) score += pts
      }
    } else if (q.type === 'fill') {
      const ans = document.getElementById(`ans_${q.id}`)?.value.trim()
      userAnswers[q.id] = ans
      if (ans && ans.toLowerCase() === String(q.answer).toLowerCase()) score += pts
    } else if (q.type === 'matching') {
      const pairs = q.options || []
      const userMap = {}
      let allCorrect = pairs.length > 0
      pairs.forEach((p, pi) => {
        const val = document.getElementById(`match_${q.id}_${pi}`)?.value
        userMap[p.left] = val
        if (!val || val !== q.answer[p.left]) allCorrect = false
      })
      userAnswers[q.id] = userMap
      if (allCorrect) score += pts
    } else if (q.type === 'dragdrop') {
      const list = document.getElementById(`dd_list_${q.id}`)
      const items = list ? [...list.querySelectorAll('.dd-item')].map(el => el.dataset.value) : []
      userAnswers[q.id] = items
      if (JSON.stringify(items) === JSON.stringify(q.answer)) score += pts
    }
  })

  const percent = total > 0 ? Math.round((score / total) * 100) : 0
  const passed = percent >= 80

  try {
    await supabase.from(QUIZ_RESULTS_TABLE).insert({
      user_id: session.user.id, quiz_type: quizType, score, total, answers: userAnswers
    })
  } catch { /* ไม่ block UI */ }

  const resultArea = document.getElementById('quizResultArea')
  if (resultArea) {
    resultArea.innerHTML = `
      <div class="bg-white rounded-2xl shadow-sm border ${passed ? 'border-emerald-200' : 'border-orange-200'} p-12 text-center">
        <div class="text-7xl mb-5">${passed ? '🎉' : '📚'}</div>
        <p class="text-5xl font-extrabold ${passed ? 'text-emerald-600' : 'text-orange-500'} mb-3">${percent}%</p>
        <p class="text-slate-500 text-lg mb-2">ได้ <strong>${score}</strong> คะแนน จากคะแนนเต็ม <strong>${total}</strong> คะแนน</p>
        ${quizType === 'posttest' ? `<p class="font-bold text-xl ${passed ? 'text-emerald-700' : 'text-orange-600'} mt-4">${passed ? '✅ ผ่านเกณฑ์ (80% ขึ้นไป)' : '❌ ยังไม่ผ่านเกณฑ์ 80%'}</p>` : ''}
        ${quizType === 'posttest' && !passed ? `<button onclick="loadContent('${quizType}')" class="mt-8 px-10 py-3.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition shadow-md">ทำแบบทดสอบใหม่อีกครั้ง</button>` : ''}
      </div>
    `
    resultArea.scrollIntoView({ behavior: 'smooth' })
  }
}

// ==========================================
// VIDEO QUIZ SYSTEM
// ==========================================

function destroyVideoPlayer() {
  if (videoCheckInterval) { clearInterval(videoCheckInterval); videoCheckInterval = null }
  if (ytPlayer && typeof ytPlayer.destroy === 'function') { try { ytPlayer.destroy() } catch { }; ytPlayer = null }
  maxReachedTime = 0
  videoQuestionsForCourse = []
  answeredVideoQuestions = new Set()
}

function extractYouTubeId(url) {
  if (!url) return ''
  if (url.includes('embed/')) return url.split('embed/')[1].split('?')[0]
  if (url.includes('watch?v=')) return url.split('watch?v=')[1].split('&')[0]
  if (url.includes('youtu.be/')) return url.split('youtu.be/')[1].split('?')[0]
  return ''
}

async function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) return
  await new Promise(resolve => {
    window.onYouTubeIframeAPIReady = resolve
    if (!document.getElementById('yt-api-script')) {
      const s = document.createElement('script')
      s.id = 'yt-api-script'
      s.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(s)
    }
  })
}

async function initVideoPlayer(videoUrl, courseId, hasVideoQuiz) {
  const videoId = extractYouTubeId(videoUrl)
  if (!videoId) return

  if (hasVideoQuiz) {
    const { data } = await supabase
      .from(VIDEO_QUESTIONS_TABLE).select('*')
      .eq('course_id', courseId).order('timestamp_sec', { ascending: true })
    videoQuestionsForCourse = data || []
  }

  await loadYouTubeAPI()

  ytPlayer = new YT.Player('ytPlayerContainer', {
    videoId,
    width: '100%',
    height: '100%',
    playerVars: { rel: 0, modestbranding: 1, disablekb: hasVideoQuiz ? 1 : 0 },
    events: {
      onReady: () => { if (hasVideoQuiz) startVideoMonitor() },
    }
  })
}

function startVideoMonitor() {
  if (videoCheckInterval) clearInterval(videoCheckInterval)
  videoCheckInterval = setInterval(() => {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return
    if (ytPlayer.getPlayerState() !== 1) return

    const currentTime = ytPlayer.getCurrentTime()

    if (currentTime > maxReachedTime + 2) {
      ytPlayer.seekTo(maxReachedTime, true)
      return
    }
    maxReachedTime = Math.max(maxReachedTime, currentTime)

    for (const q of videoQuestionsForCourse) {
      if (!answeredVideoQuestions.has(q.id) &&
        currentTime >= q.timestamp_sec &&
        currentTime < q.timestamp_sec + 1.5) {
        ytPlayer.pauseVideo()
        showVideoQuestionModal(q)
        break
      }
    }
  }, 500)
}

function showVideoQuestionModal(q) {
  currentVideoQuestion = q
  currentVQFirstTry = true
  const opts = Array.isArray(q.options) ? q.options : []

  document.getElementById('vqQuestion').textContent = q.question
  document.getElementById('vqOptions').innerHTML = opts.map(opt => `
    <label class="flex items-center gap-3 p-3.5 border border-slate-200 rounded-xl cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition">
      <input type="radio" name="vq_opt" value="${escapeHtml(opt)}" class="accent-blue-600 shrink-0 w-4 h-4">
      <span class="text-sm text-slate-700">${escapeHtml(opt)}</span>
    </label>`).join('')

  document.getElementById('vqFeedback').textContent = ''
  document.getElementById('vqSubmitBtn').classList.remove('hidden')
  document.getElementById('vqContinueBtn').classList.add('hidden')
  document.getElementById('videoQuizModal').classList.remove('hidden')
}

window.submitVideoQuestion = async () => {
  const selected = document.querySelector('input[name="vq_opt"]:checked')?.value
  if (!selected) { alert('กรุณาเลือกคำตอบก่อนครับ'); return }

  const q = currentVideoQuestion
  const isCorrect = selected === q.answer
  const feedbackEl = document.getElementById('vqFeedback')

  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      await supabase.from(VIDEO_WATCH_LOGS_TABLE).insert({
        user_id: session.user.id, course_id: q.course_id,
        question_id: q.id, is_correct: isCorrect, first_try: currentVQFirstTry
      })
    }
  } catch { }

  if (isCorrect) {
    feedbackEl.textContent = '✅ ถูกต้อง! กดดูวิดีโอต่อได้เลย'
    feedbackEl.className = 'mt-4 text-center font-bold text-emerald-600'
    answeredVideoQuestions.add(q.id)
    document.getElementById('vqSubmitBtn').classList.add('hidden')
    document.getElementById('vqContinueBtn').classList.remove('hidden')
  } else {
    feedbackEl.textContent = '❌ ไม่ถูกต้อง ลองเลือกใหม่อีกครั้ง'
    feedbackEl.className = 'mt-4 text-center font-bold text-red-500'
    currentVQFirstTry = false
    document.querySelectorAll('input[name="vq_opt"]').forEach(r => r.checked = false)
  }
}

window.continueVideo = () => {
  document.getElementById('videoQuizModal').classList.add('hidden')
  if (ytPlayer) ytPlayer.playVideo()
}

// ---- Admin: จัดการคำถามวิดีโอ ----

window.toggleVideoQuiz = async (courseId, newValue) => {
  const { error } = await supabase.from(COURSES_TABLE)
    .update({ has_video_quiz: newValue }).eq('course_id', courseId)
  if (error) { alert('อัปเดตไม่สำเร็จ: ' + error.message); return }
  await fetchCourses()
  window.loadContent('admin')
}

async function renderVideoAdminPage(course) {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-4xl mx-auto w-full animate-fade-in'

  const { data: vqs, error } = await supabase
    .from(VIDEO_QUESTIONS_TABLE).select('*')
    .eq('course_id', course.course_id).order('timestamp_sec', { ascending: true })

  if (error) {
    container.innerHTML = `<p class="text-red-500 text-center py-12">โหลดคำถามไม่สำเร็จ: ${error.message}</p>`
    contentArea.appendChild(container)
    return
  }

  function secsToMMSS(s) {
    const m = Math.floor(s / 60)
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  const rows = (vqs || []).map(q => `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4 font-mono font-bold text-amber-700">${secsToMMSS(q.timestamp_sec)}</td>
      <td class="p-4 text-sm text-slate-700 max-w-xs"><p class="line-clamp-2">${escapeHtml(q.question)}</p></td>
      <td class="p-4 text-xs text-slate-500">${(q.options || []).map(o => escapeHtml(o)).join(' / ')}</td>
      <td class="p-4"><div class="flex gap-2 justify-end">
        <button onclick="editVideoQuestion('${q.id}')" class="px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded text-xs font-bold">แก้ไข</button>
        <button onclick="deleteVideoQuestion('${q.id}', '${course.course_id}')" class="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded text-xs font-bold">ลบ</button>
      </div></td>
    </tr>`).join('')

  container.innerHTML = `
    <div class="flex items-center justify-between mb-8">
      <div>
        <button onclick="loadContent('admin')" class="text-xs text-slate-400 hover:text-slate-600 mb-2 flex items-center gap-1">← กลับ</button>
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-amber-100 text-amber-600 rounded-xl flex items-center justify-center text-2xl">🎬</div>
          <div>
            <h1 class="text-2xl font-extrabold text-slate-800">คำถามวิดีโอ — ${escapeHtml(course.course_name)}</h1>
            <p class="text-sm text-slate-500">${(vqs || []).length} คำถาม</p>
          </div>
        </div>
      </div>
      <button onclick="openVideoQuestionModal(null, '${course.course_id}')" class="bg-amber-500 hover:bg-amber-600 text-white px-6 py-3 rounded-xl font-bold shadow-md flex items-center gap-2 transition">➕ เพิ่มคำถาม</button>
    </div>
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      ${(vqs || []).length === 0
      ? '<p class="text-center text-slate-400 py-16">ยังไม่มีคำถาม กด "เพิ่มคำถาม" เพื่อเริ่มต้น</p>'
      : `<table class="w-full text-left text-sm text-slate-600">
            <thead class="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
              <tr><th class="p-4">เวลา</th><th class="p-4">คำถาม</th><th class="p-4">ตัวเลือก</th><th class="p-4 text-right">การจัดการ</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>
  `
  contentArea.appendChild(container)
}

window.openVideoQuestionModal = (questionData, courseId) => {
  editingVideoQuestionId = questionData?.id || null
  const cid = courseId || questionData?.course_id || ''
  document.getElementById('vqAdminCourseId').value = cid
  document.getElementById('vqAdminModalTitle').textContent = questionData ? 'แก้ไขคำถามวิดีโอ' : 'เพิ่มคำถามวิดีโอ'
  document.getElementById('vqAdminStatus').textContent = ''

  const mmss = questionData
    ? `${String(Math.floor(questionData.timestamp_sec / 60)).padStart(2, '0')}:${String(questionData.timestamp_sec % 60).padStart(2, '0')}`
    : ''
  document.getElementById('vqAdminTimestamp').value = mmss
  document.getElementById('vqAdminQuestion').value = questionData?.question || ''
  const opts = questionData?.options || ['', '', '', '']
    ;['A', 'B', 'C', 'D'].forEach((l, i) => {
      const el = document.getElementById(`vqopt_${l}`)
      if (el) el.value = opts[i] || ''
    })
  const answerIndex = (questionData?.options || []).indexOf(questionData?.answer)
  const correctLabel = ['A', 'B', 'C', 'D'][answerIndex] || 'A'
  const radio = document.querySelector(`input[name="vq_correct"][value="${correctLabel}"]`)
  if (radio) radio.checked = true

  document.getElementById('videoQuestionAdminModal').classList.remove('hidden')

  // โหลด preview วิดีโอ
  const course = globalCourses.find(c => c.course_id === cid)
  initVQPreview(course?.video_url || '')
}

function getYouTubeVideoId(url) {
  if (!url) return null
  const embedMatch = url.match(/youtube\.com\/embed\/([^?&/]+)/)
  if (embedMatch) return embedMatch[1]
  const watchMatch = url.match(/[?&]v=([^&]+)/)
  if (watchMatch) return watchMatch[1]
  const shortMatch = url.match(/youtu\.be\/([^?&/]+)/)
  if (shortMatch) return shortMatch[1]
  return null
}

function initVQPreview(videoUrl) {
  const placeholder = document.getElementById('vqPreviewPlaceholder')
  const playerContainer = document.getElementById('vqPlayerContainer')
  const timeEl = document.getElementById('vqCurrentTime')
  const durEl = document.getElementById('vqDuration')
  const slider = document.getElementById('vqTimeSlider')

  if (timeEl) timeEl.textContent = '00:00'
  if (durEl) durEl.textContent = '/ --:--'
  if (slider) { slider.max = 100; slider.value = 0 }

  if (window._vqTimeInterval) clearInterval(window._vqTimeInterval)
  if (vqPlayer) { try { vqPlayer.destroy() } catch (_) { } vqPlayer = null }

  const videoId = getYouTubeVideoId(videoUrl)
  if (!videoId) {
    placeholder?.classList.remove('hidden')
    playerContainer?.classList.add('hidden')
    return
  }

  placeholder?.classList.add('hidden')
  playerContainer?.classList.remove('hidden')
  playerContainer.innerHTML = '<div id="vqYTPlayer"></div>'

  function createVQPlayer() {
    vqPlayer = new window.YT.Player('vqYTPlayer', {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { controls: 1, rel: 0, modestbranding: 1 },
      events: { onReady: startVQPolling }
    })
  }

  if (window.YT && window.YT.Player) {
    createVQPlayer()
  } else {
    window._vqPendingCreate = createVQPlayer
    if (!document.getElementById('ytApiScript')) {
      const s = document.createElement('script')
      s.id = 'ytApiScript'
      s.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(s)
    }
    const prevReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (prevReady) prevReady()
      if (window._vqPendingCreate) { window._vqPendingCreate(); window._vqPendingCreate = null }
    }
  }
}

function startVQPolling() {
  if (window._vqTimeInterval) clearInterval(window._vqTimeInterval)
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  window._vqTimeInterval = setInterval(() => {
    if (!vqPlayer || typeof vqPlayer.getCurrentTime !== 'function') return
    try {
      const sec = Math.floor(vqPlayer.getCurrentTime())
      const dur = Math.floor(vqPlayer.getDuration()) || 0

      const timeEl = document.getElementById('vqCurrentTime')
      if (timeEl) timeEl.textContent = fmt(sec)

      const durEl = document.getElementById('vqDuration')
      if (durEl && dur > 0) durEl.textContent = `/ ${fmt(dur)}`

      const slider = document.getElementById('vqTimeSlider')
      if (slider && dur > 0) {
        if (Number(slider.max) !== dur) slider.max = dur
        if (!window._vqSliderDragging) slider.value = sec
      }
    } catch (_) { }
  }, 300)
}

window.editVideoQuestion = async (id) => {
  const { data: q } = await supabase.from(VIDEO_QUESTIONS_TABLE).select('*').eq('id', id).single()
  if (!q) { alert('ไม่พบคำถาม'); return }
  openVideoQuestionModal(q, q.course_id)
}

window.closeVideoQuestionModal = () => {
  document.getElementById('videoQuestionAdminModal').classList.add('hidden')
  if (window._vqTimeInterval) clearInterval(window._vqTimeInterval)
  if (vqPlayer) { try { vqPlayer.destroy() } catch (_) { } vqPlayer = null }
  const container = document.getElementById('vqPlayerContainer')
  if (container) container.innerHTML = ''
}

window.vqSeekTo = (value) => {
  if (vqPlayer && typeof vqPlayer.seekTo === 'function') {
    vqPlayer.seekTo(parseInt(value), true)
  }
}

window.vqCaptureTime = () => {
  const timeText = document.getElementById('vqCurrentTime')?.textContent || '00:00'
  document.getElementById('vqAdminTimestamp').value = timeText
}

// รับเวลาจาก YouTube iframe API via postMessage
window.addEventListener('message', (e) => {
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    if (data?.event === 'infoDelivery' && data?.info?.currentTime !== undefined) {
      const sec = Math.floor(data.info.currentTime)
      const mm = String(Math.floor(sec / 60)).padStart(2, '0')
      const ss = String(sec % 60).padStart(2, '0')
      const el = document.getElementById('vqCurrentTime')
      if (el) el.textContent = `${mm}:${ss}`
    }
  } catch (_) { }
})

window.vqCaptureTime = () => {
  const timeText = document.getElementById('vqCurrentTime')?.textContent || '00:00'
  document.getElementById('vqAdminTimestamp').value = timeText
}

window.saveVideoQuestion = async () => {
  const statusEl = document.getElementById('vqAdminStatus')
  const courseId = document.getElementById('vqAdminCourseId').value
  const timestampRaw = document.getElementById('vqAdminTimestamp').value.trim()
  const question = document.getElementById('vqAdminQuestion').value.trim()
  const correctLabel = document.querySelector('input[name="vq_correct"]:checked')?.value

  const [mm, ss] = timestampRaw.split(':').map(Number)
  const timestamp_sec = (mm || 0) * 60 + (ss || 0)

  const optMap = {}
    ;['A', 'B', 'C', 'D'].forEach(l => {
      const v = document.getElementById(`vqopt_${l}`)?.value.trim()
      if (v) optMap[l] = v
    })
  const options = ['A', 'B', 'C', 'D'].map(l => optMap[l]).filter(Boolean)
  const answer = optMap[correctLabel] || null

  if (!question || !timestampRaw || options.length < 2 || !answer) {
    statusEl.textContent = 'กรุณากรอกข้อมูลให้ครบ (เวลา, คำถาม, ตัวเลือก, คำตอบที่ถูก)'
    statusEl.className = 'mt-3 text-sm font-bold text-red-500'
    return
  }

  statusEl.textContent = 'กำลังบันทึก...'
  statusEl.className = 'mt-3 text-sm font-bold text-blue-500'

  try {
    const payload = { course_id: courseId, timestamp_sec, question, options, answer }
    const mutation = editingVideoQuestionId
      ? supabase.from(VIDEO_QUESTIONS_TABLE).update(payload).eq('id', editingVideoQuestionId)
      : supabase.from(VIDEO_QUESTIONS_TABLE).insert(payload)
    const { error } = await mutation
    if (error) throw error
    closeVideoQuestionModal()
    const course = globalCourses.find(c => c.course_id === courseId)
    if (course) renderVideoAdminPage(course)
  } catch (err) {
    statusEl.textContent = `บันทึกไม่สำเร็จ: ${err.message}`
    statusEl.className = 'mt-3 text-sm font-bold text-red-500'
  }
}

window.deleteVideoQuestion = async (id, courseId) => {
  if (!confirm('ต้องการลบคำถามนี้ใช่หรือไม่?')) return
  const { error } = await supabase.from(VIDEO_QUESTIONS_TABLE).delete().eq('id', id)
  if (error) { alert('ลบไม่สำเร็จ: ' + error.message); return }
  const course = globalCourses.find(c => c.course_id === courseId)
  if (course) renderVideoAdminPage(course)
}

// ==========================================
// ระบบ Staff Dashboard
// ==========================================

async function renderStaffDashboard() {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-4xl mx-auto w-full animate-fade-in'

  const { data: users, error } = await supabase.rpc('get_all_profiles')
  if (error) {
    container.innerHTML = `<p class="text-red-500 text-center py-12">โหลดข้อมูลไม่สำเร็จ: ${error.message}</p>`
    contentArea.appendChild(container)
    return
  }

  const pending = (users || []).filter(u => u.status === 'pending')
  const approved = (users || []).filter(u => u.status === 'approved')
  const rejected = (users || []).filter(u => u.status === 'rejected')

  const statCard = (emoji, label, count, color) => `
    <div class="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-4 shadow-sm">
      <div class="w-14 h-14 rounded-xl ${color} flex items-center justify-center text-2xl shrink-0">${emoji}</div>
      <div>
        <p class="text-3xl font-extrabold text-slate-800">${count}</p>
        <p class="text-sm text-slate-500 font-medium">${label}</p>
      </div>
    </div>`

  const pendingRows = pending.map(u => `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4">
        <p class="font-bold text-slate-800 text-sm">${escapeHtml(u.full_name || '-')}</p>
        <p class="text-xs text-slate-400">${escapeHtml(u.school_name || '-')}</p>
      </td>
      <td class="p-4 text-xs text-slate-500">${escapeHtml(u.email || '-')}</td>
      <td class="p-4">
        <div class="flex gap-2">
          <button onclick="approveUser('${u.id}')" class="px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded text-xs font-bold">อนุมัติ</button>
          <button onclick="rejectUser('${u.id}')" class="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded text-xs font-bold">ปฏิเสธ</button>
        </div>
      </td>
    </tr>`).join('')

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-8">
      <div class="w-12 h-12 bg-teal-100 text-teal-600 rounded-xl flex items-center justify-center text-2xl">🏠</div>
      <div>
        <h1 class="text-3xl font-extrabold text-slate-800">ภาพรวมระบบ</h1>
        <p class="text-sm text-slate-500">Staff Dashboard</p>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-4 mb-8">
      ${statCard('⏳', 'รอการอนุมัติ', pending.length, 'bg-amber-100 text-amber-600')}
      ${statCard('✅', 'อนุมัติแล้ว', approved.length, 'bg-emerald-100 text-emerald-600')}
      ${statCard('❌', 'ถูกปฏิเสธ', rejected.length, 'bg-red-100 text-red-600')}
    </div>

    ${pending.length > 0 ? `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
      <div class="px-6 py-4 border-b border-slate-200 bg-amber-50 flex items-center justify-between">
        <p class="font-bold text-amber-700 text-sm">⏳ รอการอนุมัติ (${pending.length} คน)</p>
        <button onclick="loadContent('approvals')" class="text-xs text-amber-600 hover:text-amber-800 font-bold">ดูทั้งหมด →</button>
      </div>
      <table class="w-full text-left text-sm">
        <thead class="text-slate-600 font-bold border-b border-slate-100 bg-slate-50">
          <tr><th class="p-4">ชื่อ / หน่วยงาน</th><th class="p-4">อีเมล</th><th class="p-4">การดำเนินการ</th></tr>
        </thead>
        <tbody>${pendingRows}</tbody>
      </table>
    </div>` : `
    <div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center text-emerald-700 font-bold mb-6">
      ✅ ไม่มีผู้อบรมรอการอนุมัติ
    </div>`}

    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
      <p class="font-bold text-slate-700 mb-1">สมาชิกทั้งหมด</p>
      <p class="text-4xl font-extrabold text-slate-800">${(users || []).length} <span class="text-lg font-normal text-slate-400">คน</span></p>
    </div>
  `
  contentArea.appendChild(container)
}

// ==========================================
// ระบบ Mentor Dashboard
// ==========================================

async function renderMentorDashboard() {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-4xl mx-auto w-full animate-fade-in'

  const [{ data: users }, { data: results }] = await Promise.all([
    supabase.rpc('get_all_profiles'),
    supabase.from('quiz_results').select('user_id, quiz_type, score, passed')
  ])

  const trainees = (users || []).filter(u => u.status === 'approved' && u.role === 'student')
  const passedIds = new Set((results || []).filter(r => r.quiz_type === 'posttest' && r.passed).map(r => r.user_id))
  const passedCount = trainees.filter(u => passedIds.has(u.id)).length

  const courseCount = globalCourses.filter(c => c.status === 'เปิดสอน').length

  const statCard = (emoji, label, count, color) => `
    <div class="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-4 shadow-sm">
      <div class="w-14 h-14 rounded-xl ${color} flex items-center justify-center text-2xl shrink-0">${emoji}</div>
      <div>
        <p class="text-3xl font-extrabold text-slate-800">${count}</p>
        <p class="text-sm text-slate-500 font-medium">${label}</p>
      </div>
    </div>`

  const recentTrainees = trainees.slice(0, 5).map(u => {
    const passed = passedIds.has(u.id)
    return `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4">
        <p class="font-bold text-slate-800 text-sm">${escapeHtml(u.full_name || '-')}</p>
        <p class="text-xs text-slate-400">${escapeHtml(u.school_name || '-')}</p>
      </td>
      <td class="p-4 text-xs text-slate-500">${escapeHtml(u.email || '-')}</td>
      <td class="p-4 text-center">
        ${passed
        ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs rounded-full font-bold">ผ่านแล้ว</span>'
        : '<span class="px-2 py-1 bg-slate-100 text-slate-500 text-xs rounded-full font-bold">ยังไม่ผ่าน</span>'}
      </td>
    </tr>`
  }).join('')

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-8">
      <div class="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl">🏠</div>
      <div>
        <h1 class="text-3xl font-extrabold text-slate-800">ภาพรวม</h1>
        <p class="text-sm text-slate-500">Mentor Dashboard</p>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-4 mb-8">
      ${statCard('👥', 'ผู้อบรมที่อนุมัติแล้ว', trainees.length, 'bg-blue-100 text-blue-600')}
      ${statCard('🏆', 'ผ่านแบบทดสอบหลังเรียน', passedCount, 'bg-emerald-100 text-emerald-600')}
      ${statCard('📚', 'รายวิชาที่เปิดสอน', courseCount, 'bg-violet-100 text-violet-600')}
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <p class="font-bold text-slate-700 text-sm">ผู้อบรมล่าสุด</p>
        <button onclick="loadContent('mentorTrainees')" class="text-xs text-blue-600 hover:text-blue-800 font-bold">ดูทั้งหมด →</button>
      </div>
      ${trainees.length > 0 ? `
      <table class="w-full text-left text-sm text-slate-600">
        <thead class="text-slate-700 font-bold border-b border-slate-200 bg-slate-50">
          <tr><th class="p-4">ชื่อ / หน่วยงาน</th><th class="p-4">อีเมล</th><th class="p-4 text-center">สถานะ Posttest</th></tr>
        </thead>
        <tbody>${recentTrainees}</tbody>
      </table>` : '<p class="text-center text-slate-400 py-8">ยังไม่มีผู้อบรม</p>'}
    </div>
  `
  contentArea.appendChild(container)
}

async function renderMentorTrainees() {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-4xl mx-auto w-full animate-fade-in'

  const [{ data: users }, { data: results }] = await Promise.all([
    supabase.rpc('get_all_profiles'),
    supabase.from('quiz_results').select('user_id, quiz_type, score, passed')
  ])

  const trainees = (users || []).filter(u => u.status === 'approved' && u.role === 'student')
  const passedIds = new Set((results || []).filter(r => r.quiz_type === 'posttest' && r.passed).map(r => r.user_id))

  const rows = trainees.map(u => {
    const passed = passedIds.has(u.id)
    return `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4">
        <p class="font-bold text-slate-800 text-sm">${escapeHtml(u.full_name || '-')}</p>
        <p class="text-xs text-slate-400">${escapeHtml(u.school_name || '-')}</p>
      </td>
      <td class="p-4 text-xs text-slate-500">${escapeHtml(u.email || '-')}</td>
      <td class="p-4 text-center">
        ${passed
        ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs rounded-full font-bold">ผ่านแล้ว</span>'
        : '<span class="px-2 py-1 bg-slate-100 text-slate-500 text-xs rounded-full font-bold">ยังไม่ผ่าน</span>'}
      </td>
    </tr>`
  }).join('')

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-8">
      <div class="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl">👥</div>
      <div>
        <h1 class="text-3xl font-extrabold text-slate-800">ผู้อบรมทั้งหมด</h1>
        <p class="text-sm text-slate-500">${trainees.length} คน</p>
      </div>
    </div>
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      ${trainees.length > 0 ? `
      <table class="w-full text-left text-sm text-slate-600">
        <thead class="text-slate-700 font-bold border-b border-slate-200 bg-slate-50">
          <tr><th class="p-4">ชื่อ / หน่วยงาน</th><th class="p-4">อีเมล</th><th class="p-4 text-center">สถานะ Posttest</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : '<p class="text-center text-slate-400 py-8">ยังไม่มีผู้อบรม</p>'}
    </div>
  `
  contentArea.appendChild(container)
}

async function renderMentorReview() {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-5xl mx-auto w-full animate-fade-in'

  const { data: submissions, error } = await supabase.rpc('get_all_submissions')
  if (error) {
    container.innerHTML = `<p class="text-red-500 text-center py-12">โหลดข้อมูลไม่สำเร็จ: ${error.message}</p>`
    contentArea.appendChild(container)
    return
  }

  const courseMap = Object.fromEntries(globalCourses.map(c => [c.course_id, c.course_name]))
  const pending = (submissions || []).filter(s => !s.reviewed)
  const reviewed = (submissions || []).filter(s => s.reviewed)

  const formatDate = (iso) => {
    if (!iso) return '-'
    const d = new Date(iso)
    return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const renderSubmissionRow = (s) => `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4">
        <p class="font-bold text-slate-800 text-sm">${escapeHtml(s.full_name || '-')}</p>
        <p class="text-xs text-slate-400">${escapeHtml(s.school_name || '-')}</p>
      </td>
      <td class="p-4 text-sm text-slate-600">${escapeHtml(courseMap[s.course_id] || s.course_id)}</td>
      <td class="p-4 text-xs text-slate-400">${formatDate(s.created_at)}</td>
      <td class="p-4">
        <a href="${escapeHtml(s.file_url)}" target="_blank" rel="noopener"
           class="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded text-xs font-bold transition">
          📎 ดาวน์โหลด
        </a>
      </td>
      <td class="p-4">
        ${s.reviewed
      ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs rounded-full font-bold">ตรวจแล้ว</span>'
      : '<span class="px-2 py-1 bg-amber-100 text-amber-700 text-xs rounded-full font-bold">รอตรวจ</span>'}
      </td>
      <td class="p-4">
        <button onclick="openReviewModal('${s.id}', ${JSON.stringify(s.full_name || '-')}, ${JSON.stringify(courseMap[s.course_id] || s.course_id)}, ${s.reviewed}, ${JSON.stringify(s.feedback || '')})"
          class="px-3 py-1.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded text-xs font-bold">
          ${s.reviewed ? 'ดูผล' : 'ตรวจงาน'}
        </button>
      </td>
    </tr>`

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-8">
      <div class="w-12 h-12 bg-orange-100 text-orange-600 rounded-xl flex items-center justify-center text-2xl">📋</div>
      <div>
        <h1 class="text-3xl font-extrabold text-slate-800">ตรวจงาน</h1>
        <p class="text-sm text-slate-500">รอตรวจ ${pending.length} งาน · ตรวจแล้ว ${reviewed.length} งาน</p>
      </div>
    </div>

    ${pending.length > 0 ? `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
      <div class="px-6 py-4 border-b border-amber-200 bg-amber-50">
        <p class="font-bold text-amber-700 text-sm">⏳ รอตรวจ (${pending.length} งาน)</p>
      </div>
      <table class="w-full text-left text-sm">
        <thead class="text-slate-600 font-bold border-b border-slate-100 bg-slate-50">
          <tr><th class="p-4">ผู้อบรม</th><th class="p-4">วิชา</th><th class="p-4">วันที่ส่ง</th><th class="p-4">ไฟล์งาน</th><th class="p-4">สถานะ</th><th class="p-4"></th></tr>
        </thead>
        <tbody>${pending.map(s => renderSubmissionRow(s)).join('')}</tbody>
      </table>
    </div>` : `
    <div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center text-emerald-700 font-bold mb-6">
      ✅ ไม่มีงานรอตรวจ
    </div>`}

    ${reviewed.length > 0 ? `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="px-6 py-4 border-b border-slate-200 bg-slate-50">
        <p class="font-bold text-slate-600 text-sm">ตรวจแล้ว (${reviewed.length} งาน)</p>
      </div>
      <table class="w-full text-left text-sm">
        <thead class="text-slate-600 font-bold border-b border-slate-100 bg-slate-50">
          <tr><th class="p-4">ผู้อบรม</th><th class="p-4">วิชา</th><th class="p-4">วันที่ส่ง</th><th class="p-4">ไฟล์งาน</th><th class="p-4">สถานะ</th><th class="p-4"></th></tr>
        </thead>
        <tbody>${reviewed.map(s => renderSubmissionRow(s)).join('')}</tbody>
      </table>
    </div>` : ''}
  `
  contentArea.appendChild(container)
}

window.openReviewModal = (id, name, courseName, isReviewed, feedback) => {
  const existing = document.getElementById('reviewModal')
  if (existing) existing.remove()

  const modal = document.createElement('div')
  modal.id = 'reviewModal'
  modal.className = 'fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4'
  modal.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md">
      <div class="p-6 border-b border-slate-100 flex justify-between items-center">
        <div>
          <h2 class="text-lg font-bold text-slate-800">ตรวจงาน</h2>
          <p class="text-xs text-slate-400 mt-0.5">${escapeHtml(name)} — ${escapeHtml(courseName)}</p>
        </div>
        <button onclick="document.getElementById('reviewModal').remove()" class="text-slate-400 hover:text-slate-600 text-2xl">✕</button>
      </div>
      <div class="p-6 space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-500 mb-1">ข้อเสนอแนะ / ผลการตรวจ</label>
          <textarea id="reviewFeedback" rows="4" placeholder="กรอกข้อเสนอแนะ (ถ้ามี)"
            class="w-full p-3 border border-slate-200 rounded-lg outline-none focus:border-indigo-400 text-sm resize-none">${escapeHtml(feedback)}</textarea>
        </div>
        <div class="flex items-center gap-3">
          <label class="text-sm font-medium text-slate-600">สถานะ:</label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="reviewChecked" ${isReviewed ? 'checked' : ''} class="w-4 h-4 accent-emerald-600">
            <span class="text-sm font-bold text-emerald-700">ตรวจแล้ว</span>
          </label>
        </div>
        <p id="reviewMsg" class="text-sm text-center font-medium"></p>
      </div>
      <div class="p-6 border-t border-slate-100 flex justify-end gap-3">
        <button onclick="document.getElementById('reviewModal').remove()" class="px-5 py-2 rounded-lg text-slate-600 font-bold hover:bg-slate-100">ยกเลิก</button>
        <button onclick="saveReview('${id}')" class="px-5 py-2 rounded-lg bg-indigo-600 text-white font-bold hover:bg-indigo-700">บันทึก</button>
      </div>
    </div>`
  document.body.appendChild(modal)
}

window.saveReview = async (submissionId) => {
  const feedback = document.getElementById('reviewFeedback').value.trim()
  const reviewed = document.getElementById('reviewChecked').checked
  const msg = document.getElementById('reviewMsg')

  msg.textContent = 'กำลังบันทึก...'
  msg.className = 'text-sm text-center font-medium text-blue-500'

  const { error } = await supabase.rpc('review_submission', {
    submission_id: submissionId,
    new_reviewed: reviewed,
    new_feedback: feedback || null
  })

  if (error) {
    msg.textContent = 'บันทึกไม่สำเร็จ: ' + error.message
    msg.className = 'text-sm text-center font-medium text-red-500'
    return
  }

  document.getElementById('reviewModal').remove()
  renderMentorReview()
}

// ==========================================
// ระบบอนุมัติผู้อบรม
// ==========================================

async function renderApprovalsPage() {
  contentArea.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'max-w-4xl mx-auto w-full animate-fade-in'

  const { data: users, error } = await supabase
    .rpc('get_all_profiles')

  if (error) {
    container.innerHTML = `<p class="text-red-500 text-center py-12">โหลดข้อมูลไม่สำเร็จ: ${error.message}</p>`
    contentArea.appendChild(container)
    return
  }

  const pending = (users || []).filter(u => u.status === 'pending')
  const others = (users || []).filter(u => u.status !== 'pending')

  const statusBadge = (s) => {
    if (s === 'approved') return '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs rounded-full font-bold">อนุมัติแล้ว</span>'
    if (s === 'rejected') return '<span class="px-2 py-1 bg-red-100 text-red-600 text-xs rounded-full font-bold">ปฏิเสธ</span>'
    return '<span class="px-2 py-1 bg-amber-100 text-amber-700 text-xs rounded-full font-bold">รอการอนุมัติ</span>'
  }

  const roleLabel = (r) => {
    if (r === 'admin') return '<span class="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded-full font-bold">Admin</span>'
    if (r === 'teacher') return '<span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full font-bold">Mentor</span>'
    if (r === 'staff') return '<span class="px-2 py-0.5 bg-teal-100 text-teal-700 text-xs rounded-full font-bold">Staff</span>'
    return '<span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full font-bold">Trainee</span>'
  }

  const renderPendingRow = (u) => `
    <tr class="hover:bg-slate-50 border-b border-slate-100">
      <td class="p-4">
        <p class="font-bold text-slate-800 text-sm">${escapeHtml(u.full_name || '-')}</p>
        <p class="text-xs text-slate-400">${escapeHtml(u.school_name || '-')}</p>
      </td>
      <td class="p-4 text-xs text-slate-500">${escapeHtml(u.email || '-')}</td>
      <td class="p-4">${roleLabel(u.role)}</td>
      <td class="p-4 text-center">${statusBadge(u.status)}</td>
      <td class="p-4">
        <div class="flex gap-2 justify-end">
          <button onclick="approveUser('${u.id}')" class="px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded text-xs font-bold">อนุมัติ</button>
          <button onclick="rejectUser('${u.id}')" class="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded text-xs font-bold">ปฏิเสธ</button>
          <button onclick="openEditProfileModal(${JSON.stringify(u).replace(/"/g, '&quot;')})" class="px-3 py-1.5 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded text-xs font-bold">แก้ไข</button>
        </div>
      </td>
    </tr>`

  const renderMemberRow = (u) => `
    <tr class="hover:bg-slate-50 border-b border-slate-100 member-row" data-id="${u.id}">
      <td class="p-4 w-10">
        <input type="checkbox" class="member-checkbox w-4 h-4 accent-indigo-600 cursor-pointer" data-id="${u.id}" onchange="onMemberCheckboxChange()">
      </td>
      <td class="p-4">
        <p class="font-bold text-slate-800 text-sm">${escapeHtml(u.full_name || '-')}</p>
        <p class="text-xs text-slate-400">${escapeHtml(u.school_name || '-')}</p>
      </td>
      <td class="p-4 text-xs text-slate-500">${escapeHtml(u.email || '-')}</td>
      <td class="p-4">${roleLabel(u.role)}</td>
      <td class="p-4 text-center">${statusBadge(u.status)}</td>
      <td class="p-4">
        <div class="flex gap-2 justify-end">
          ${u.status === 'rejected' ? `
            <button onclick="approveUser('${u.id}')" class="px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded text-xs font-bold">อนุมัติ</button>
          ` : ''}
          <button onclick="openEditProfileModal(${JSON.stringify(u).replace(/"/g, '&quot;')})" class="px-3 py-1.5 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded text-xs font-bold">แก้ไข</button>
          <button onclick="deleteUser('${u.id}', '${escapeHtml(u.full_name || 'ผู้ใช้นี้')}')" class="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded text-xs font-bold">ลบ</button>
        </div>
      </td>
    </tr>`

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-8">
      <div class="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center text-2xl">✅</div>
      <div>
        <h1 class="text-3xl font-extrabold text-slate-800">อนุมัติผู้อบรม</h1>
        <p class="text-sm text-slate-500">รอการอนุมัติ ${pending.length} คน</p>
      </div>
    </div>

    ${pending.length > 0 ? `
    <div class="bg-amber-50 border border-amber-200 rounded-2xl overflow-hidden mb-6">
      <div class="px-6 py-3 border-b border-amber-200 bg-amber-100/50">
        <p class="font-bold text-amber-700 text-sm">⏳ รอการอนุมัติ (${pending.length} คน)</p>
      </div>
      <table class="w-full text-left text-sm">
        <thead class="text-slate-600 font-bold border-b border-amber-200">
          <tr><th class="p-4">ชื่อ / หน่วยงาน</th><th class="p-4">อีเมล</th><th class="p-4">บทบาท</th><th class="p-4 text-center">สถานะ</th><th class="p-4"></th></tr>
        </thead>
        <tbody>${pending.map(u => renderPendingRow(u)).join('')}</tbody>
      </table>
    </div>` : '<div class="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-400 mb-6">ไม่มีผู้อบรมรอการอนุมัติ</div>'}

    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="px-6 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <p class="font-bold text-slate-600 text-sm">สมาชิกทั้งหมด (${others.length} คน)</p>
        <button id="deleteSelectedBtn" onclick="deleteSelectedUsers()" class="hidden px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-bold transition">ลบที่เลือก (<span id="selectedCount">0</span>)</button>
      </div>
      ${others.length > 0 ? `
      <table class="w-full text-left text-sm text-slate-600">
        <thead class="text-slate-700 font-bold border-b border-slate-200 bg-slate-50">
          <tr>
            <th class="p-4 w-10"><input type="checkbox" id="selectAllMembers" class="w-4 h-4 accent-indigo-600 cursor-pointer" onchange="onSelectAllMembers(this.checked)"></th>
            <th class="p-4">ชื่อ / หน่วยงาน</th><th class="p-4">อีเมล</th><th class="p-4">บทบาท</th><th class="p-4 text-center">สถานะ</th><th class="p-4"></th>
          </tr>
        </thead>
        <tbody>${others.map(u => renderMemberRow(u)).join('')}</tbody>
      </table>` : '<p class="text-center text-slate-400 py-8">ยังไม่มีสมาชิก</p>'}
    </div>
  `
  contentArea.appendChild(container)
}

window.approveUser = async (userId) => {
  const { error } = await supabase.rpc('update_profile_status', { target_id: userId, new_status: 'approved' })
  if (error) { alert('อนุมัติไม่สำเร็จ: ' + error.message); return }
  renderApprovalsPage()
}

window.rejectUser = async (userId) => {
  if (!confirm('ต้องการปฏิเสธผู้ใช้งานนี้ใช่หรือไม่?')) return
  const { error } = await supabase.rpc('update_profile_status', { target_id: userId, new_status: 'rejected' })
  if (error) { alert('ปฏิเสธไม่สำเร็จ: ' + error.message); return }
  renderApprovalsPage()
}

window.onMemberCheckboxChange = () => {
  const checked = document.querySelectorAll('.member-checkbox:checked')
  const btn = document.getElementById('deleteSelectedBtn')
  const countEl = document.getElementById('selectedCount')
  if (!btn || !countEl) return
  countEl.textContent = checked.length
  btn.classList.toggle('hidden', checked.length === 0)

  const all = document.querySelectorAll('.member-checkbox')
  const selectAll = document.getElementById('selectAllMembers')
  if (selectAll) selectAll.checked = all.length > 0 && checked.length === all.length
}

window.onSelectAllMembers = (checked) => {
  document.querySelectorAll('.member-checkbox').forEach(cb => { cb.checked = checked })
  window.onMemberCheckboxChange()
}

window.deleteUser = async (userId, name) => {
  if (!confirm(`ต้องการลบ "${name}" ออกจากระบบใช่หรือไม่?\nการลบจะไม่สามารถกู้คืนได้`)) return
  const { error } = await supabase.rpc('delete_profile', { target_id: userId })
  if (error) { alert('ลบไม่สำเร็จ: ' + error.message); return }
  renderApprovalsPage()
}

window.deleteSelectedUsers = async () => {
  const checked = [...document.querySelectorAll('.member-checkbox:checked')]
  if (checked.length === 0) return
  if (!confirm(`ต้องการลบสมาชิก ${checked.length} คน ออกจากระบบใช่หรือไม่?\nการลบจะไม่สามารถกู้คืนได้`)) return

  let failed = 0
  for (const cb of checked) {
    const { error } = await supabase.rpc('delete_profile', { target_id: cb.dataset.id })
    if (error) failed++
  }
  if (failed > 0) alert(`ลบไม่สำเร็จ ${failed} รายการ`)
  renderApprovalsPage()
}

window.openEditProfileModal = (u) => {
  const existing = document.getElementById('editProfileModal')
  if (existing) existing.remove()

  const modal = document.createElement('div')
  modal.id = 'editProfileModal'
  modal.className = 'fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4'
  modal.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md">
      <div class="p-6 border-b border-slate-100 flex justify-between items-center">
        <h2 class="text-lg font-bold text-slate-800">แก้ไขข้อมูลสมาชิก</h2>
        <button onclick="document.getElementById('editProfileModal').remove()" class="text-slate-400 hover:text-slate-600 text-2xl">✕</button>
      </div>
      <div class="p-6 space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-500 mb-1">คำนำหน้านาม</label>
          <select id="epTitle" class="w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:border-indigo-400 text-sm mb-4">
            <option value="" ${!u.title ? 'selected' : ''}>-- เลือก --</option>
            <option value="นาย" ${u.title === 'นาย' ? 'selected' : ''}>นาย</option>
            <option value="นาง" ${u.title === 'นาง' ? 'selected' : ''}>นาง</option>
            <option value="นางสาว" ${u.title === 'นางสาว' ? 'selected' : ''}>นางสาว</option>
            <option value="อื่น ๆ" ${u.title === 'อื่น ๆ' ? 'selected' : ''}>อื่น ๆ</option>
          </select>
          <label class="block text-xs font-bold text-slate-500 mb-1">ชื่อ-นามสกุล</label>
          <input id="epFullName" value="${escapeHtml(u.full_name || '')}" class="w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:border-indigo-400 text-sm">
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-500 mb-1">หน่วยงาน / โรงเรียน</label>
          <input id="epSchool" value="${escapeHtml(u.school_name || '')}" class="w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:border-indigo-400 text-sm">
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-500 mb-1">บทบาท</label>
          <select id="epRole" class="w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:border-indigo-400 text-sm">
            <option value="student" ${u.role === 'student' ? 'selected' : ''}>Trainee</option>
            <option value="teacher" ${u.role === 'teacher' ? 'selected' : ''}>Mentor</option>
            <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-500 mb-1">สถานะ</label>
          <select id="epStatus" class="w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:border-indigo-400 text-sm">
            <option value="pending" ${u.status === 'pending' ? 'selected' : ''}>รอการอนุมัติ</option>
            <option value="approved" ${u.status === 'approved' ? 'selected' : ''}>อนุมัติแล้ว</option>
            <option value="rejected" ${u.status === 'rejected' ? 'selected' : ''}>ปฏิเสธ</option>
          </select>
        </div>
        <p id="epStatus_msg" class="text-sm text-center font-medium"></p>
      </div>
      <div class="p-6 border-t border-slate-100 flex justify-end gap-3">
        <button onclick="document.getElementById('editProfileModal').remove()" class="px-5 py-2 rounded-lg text-slate-600 font-bold hover:bg-slate-100">ยกเลิก</button>
        <button onclick="saveEditProfile('${u.id}')" class="px-5 py-2 rounded-lg bg-indigo-600 text-white font-bold hover:bg-indigo-700">บันทึก</button>
      </div>
    </div>`
  document.body.appendChild(modal)
}

window.saveEditProfile = async (userId) => {
  const full_name = document.getElementById('epFullName').value.trim()
  const school_name = document.getElementById('epSchool').value.trim()
  const role = document.getElementById('epRole').value
  const status = document.getElementById('epStatus').value
  const title = document.getElementById('epTitle').value
  const msg = document.getElementById('epStatus_msg')

  msg.textContent = 'กำลังบันทึก...'
  msg.className = 'text-sm text-center font-medium text-blue-500'

  const { error } = await supabase.rpc('admin_update_profile', {
    target_id: userId,
    new_full_name: full_name,
    new_school_name: school_name,
    new_role: role,
    new_status: status,
    new_title: title
  })

  if (error) {
    msg.textContent = 'บันทึกไม่สำเร็จ: ' + error.message
    msg.className = 'text-sm text-center font-medium text-red-500'
    return
  }

  document.getElementById('editProfileModal').remove()
  renderApprovalsPage()
}
