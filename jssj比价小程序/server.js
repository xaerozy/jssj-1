const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// 初始化目录和文件数据库
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const defaultData = {
      users: [],
      procurements: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}
initDB();

function readDB() {
  try {
    const content = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.error('Read DB error:', e);
    return { users: [], procurements: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Write DB error:', e);
  }
}

// 统一的 JSON 响应辅助函数
function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// 读取 POST/PUT 请求体
function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  // 设置 CORS 跨域请求头，支持小程序模拟器请求
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // 1. 托管静态上传文件夹 (/uploads/xxx.png)
  if (pathname.startsWith('/uploads/') && method === 'GET') {
    const filename = path.basename(pathname);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
    return;
  }

  // 2. API 路由处理
  try {
    const db = readDB();

    // ================= 用户相关接口 =================
    // GET /api/users
    if (pathname === '/api/users' && method === 'GET') {
      sendJSON(res, db.users);
      return;
    }

    // POST /api/users (注册)
    if (pathname === '/api/users' && method === 'POST') {
      const body = await getRequestBody(req);
      const { name, role, desc } = body;
      
      if (!name || !role) {
        sendJSON(res, { message: '名字和角色不能为空' }, 400);
        return;
      }

      // 防重复校验
      const nameExists = db.users.some(u => u.name === name.trim());
      const phone = desc ? desc.replace('绑定手机: ', '').trim() : '';
      const phoneExists = db.users.some(u => u.desc && u.desc.includes(phone) && phone !== '');

      if (nameExists || phoneExists) {
        sendJSON(res, { message: '该姓名或手机号已被注册，每个账号只能注册一次' }, 400);
        return;
      }

      const newUser = {
        name: name.trim(),
        role: role.trim(),
        desc: desc ? desc.trim() : ''
      };
      
      db.users.push(newUser);
      writeDB(db);
      sendJSON(res, newUser, 201);
      return;
    }

    // DELETE /api/users/:name (删除/注销)
    if (pathname.startsWith('/api/users/') && method === 'DELETE') {
      const targetName = decodeURIComponent(pathname.substring('/api/users/'.length));
      const initialLength = db.users.length;
      db.users = db.users.filter(u => u.name !== targetName);

      if (db.users.length < initialLength) {
        writeDB(db);
        sendJSON(res, { message: '注销成功' });
      } else {
        sendJSON(res, { message: '用户不存在' }, 404);
      }
      return;
    }

    // ================= 比价单相关接口 =================
    // GET /api/procurements
    if (pathname === '/api/procurements' && method === 'GET') {
      sendJSON(res, db.procurements);
      return;
    }

    // GET /api/procurements/:id
    if (pathname.startsWith('/api/procurements/') && method === 'GET' && !pathname.endsWith('/approval')) {
      const id = pathname.substring('/api/procurements/'.length);
      const project = db.procurements.find(p => p.id === id);
      if (project) {
        sendJSON(res, project);
      } else {
        sendJSON(res, { message: '单据不存在' }, 404);
      }
      return;
    }

    // POST /api/procurements (新建比价单)
    if (pathname === '/api/procurements' && method === 'POST') {
      const body = await getRequestBody(req);
      db.procurements.unshift(body);
      writeDB(db);
      sendJSON(res, body, 201);
      return;
    }

    // PUT /api/procurements/:id (修改比价单)
    if (pathname.startsWith('/api/procurements/') && method === 'PUT') {
      const id = pathname.substring('/api/procurements/'.length);
      const body = await getRequestBody(req);
      const idx = db.procurements.findIndex(p => p.id === id);
      if (idx !== -1) {
        db.procurements[idx] = body;
        writeDB(db);
        sendJSON(res, body);
      } else {
        sendJSON(res, { message: '单据不存在' }, 404);
      }
      return;
    }

    // POST /api/procurements/:id/approval (签字审批/驳回)
    if (pathname.startsWith('/api/procurements/') && pathname.endsWith('/approval') && method === 'POST') {
      const parts = pathname.split('/');
      const id = parts[2];
      const body = await getRequestBody(req);
      const { action, comment, signature, role, userName } = body;

      const projectIdx = db.procurements.findIndex(p => p.id === id);
      if (projectIdx === -1) {
        sendJSON(res, { message: '单据不存在' }, 404);
        return;
      }

      const project = db.procurements[projectIdx];
      const now = new Date();
      const formattedTime = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

      const stepIdx = project.approvals.findIndex(a => a.role === role && a.status === 'pending');
      if (stepIdx === -1) {
        sendJSON(res, { message: '当前无需您审批或您已完成审批' }, 400);
        return;
      }

      if (action === 'approve') {
        project.approvals[stepIdx] = {
          role,
          status: 'approved',
          userName,
          time: formattedTime,
          comment: comment || '同意确认。',
          signature: signature // 这是网络图片 URL
        };

        // 寻找下一个审批步骤
        const nextStep = project.approvals.find(a => a.status === 'pending');
        if (nextStep) {
          const r = nextStep.role;
          if (r === '工程部') project.status = 'pending_engineering';
          else if (r === '项目部') project.status = 'pending_project';
          else if (r === '出纳') project.status = 'pending_cashier';
          else if (r === '财务') project.status = 'pending_finance';
          else if (r === '部门经理') project.status = 'pending_manager';
          else if (r === '副总经理') project.status = 'pending_vgm';
          else if (r === '总经理') project.status = 'pending_gm';
          else if (r === '董事长') project.status = 'pending_chairman';
        } else {
          project.status = 'approved';
        }
      } else {
        // 驳回
        project.approvals[stepIdx] = {
          role,
          status: 'rejected',
          userName,
          time: formattedTime,
          comment: comment,
          signature: ''
        };
        project.status = 'rejected';
      }

      db.procurements[projectIdx] = project;
      writeDB(db);
      sendJSON(res, project);
      return;
    }

    // POST /api/upload (上传手写签名 - 支持 Base64 格式，零依赖且传输方便)
    if (pathname === '/api/upload' && method === 'POST') {
      const body = await getRequestBody(req);
      const { image } = body;

      if (!image) {
        sendJSON(res, { message: '上传数据为空' }, 400);
        return;
      }

      // 处理 data:image/png;base64, 前缀
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `sig_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`;
      const filePath = path.join(UPLOADS_DIR, filename);

      fs.writeFileSync(filePath, buffer);
      
      const serverUrl = `http://localhost:${PORT}/uploads/${filename}`;
      sendJSON(res, { url: serverUrl });
      return;
    }

    // 默认 404
    sendJSON(res, { message: '路由不存在' }, 404);

  } catch (e) {
    console.error('Server execution error:', e);
    sendJSON(res, { message: '服务器内部错误: ' + e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  采购比价系统 Node.js 极简后端服务启动成功  `);
  console.log(`  监听端口: http://localhost:${PORT}        `);
  console.log(`  无任何外部依赖，开箱即用                    `);
  console.log(`========================================`);
});
