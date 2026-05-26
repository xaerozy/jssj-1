const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, 'app.js');

try {
  let content = fs.readFileSync(appJsPath, 'utf8');

  // 1. 正则匹配 version: 'V1.xx' 格式
  const versionRegex = /version:\s*'V(\d+\.\d+)'/;
  const versionMatch = content.match(versionRegex);
  
  if (versionMatch) {
    const currentVersionNum = parseFloat(versionMatch[1]);
    const nextVersionNum = (currentVersionNum + 0.01).toFixed(2);
    const nextVersionStr = `V${nextVersionNum}`;
    
    // 2. 替换版本号
    content = content.replace(versionRegex, `version: '${nextVersionStr}'`);
    
    // 3. 获取并替换最新隐藏更新时间戳 (Unix毫秒时间戳)
    const now = Date.now();
    const timestampRegex = /_updateTimestamp:\s*\d+/;
    content = content.replace(timestampRegex, `_updateTimestamp: ${now}`);
    
    fs.writeFileSync(appJsPath, content, 'utf8');
    
    // 格式化当前日期供日志展示
    const date = new Date(now);
    const offset = date.getTimezoneOffset() * 60000;
    const localISOTime = new Date(now - offset).toISOString().replace('T', ' ').substring(0, 19);
    
    console.log(`[Version Auto-Update] Version successfully bumped to ${nextVersionStr}`);
    console.log(`[Version Auto-Update] Hidden Timestamp set to: ${now} (${localISOTime})`);
  } else {
    console.error('[Version Auto-Update] Warning: Could not find version key in app.js');
  }
} catch (err) {
  console.error('[Version Auto-Update] Error updating app.js:', err);
}
