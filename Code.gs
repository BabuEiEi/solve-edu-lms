// ฟังก์ชัน doGet จะทำงานเมื่อหน้าเว็บเราร้องขอข้อมูล (HTTP GET Request)
function doGet(e) {
  // เข้าถึง Sheet ที่ชื่อว่า "Courses"
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Courses");
  
  // ดึงข้อมูลทั้งหมดมาเก็บไว้ (ดึงมาเป็น Array 2 มิติ)
  var data = sheet.getDataRange().getValues();
  
  // แยกแถวแรกสุดมาเป็น Header (ตัวแปรชื่อคอลัมน์)
  var headers = data[0];
  var result = [];
  
  // วนลูปจับคู่ Header กับ ข้อมูลในแต่ละแถวให้อยู่ในรูปแบบ JSON
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    result.push(obj);
  }
  
  // แปลงข้อมูลเป็น JSON และส่งกลับไปยังหน้าเว็บ
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ฟังก์ชัน doPost สำหรับรับข้อมูลจากหน้าเว็บมา บันทึก/แก้ไข/ลบ ใน Sheets
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Courses");
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // กรณีเพิ่มวิชาใหม่ (Add)
    if (data.action === "add") {
      var newRow = [];
      for (var i = 0; i < headers.length; i++) {
        newRow.push(data.course[headers[i]] || "");
      }
      sheet.appendRow(newRow);
    } 
    // กรณีแก้ไขวิชาเดิม (Edit)
    else if (data.action === "edit") {
      var allData = sheet.getDataRange().getValues();
      for (var r = 1; r < allData.length; r++) {
        // หาแถวที่รหัสวิชาตรงกัน
        if (allData[r][0] === data.course.course_id) { 
          for (var c = 0; c < headers.length; c++) {
            sheet.getRange(r + 1, c + 1).setValue(data.course[headers[c]] || "");
          }
          break;
        }
      }
    } 
    // กรณีลบวิชา (Delete)
    else if (data.action === "delete") {
      var allData = sheet.getDataRange().getValues();
      for (var r = 1; r < allData.length; r++) {
        if (allData[r][0] === data.course_id) {
          sheet.deleteRow(r + 1);
          break;
        }
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}