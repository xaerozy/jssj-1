const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  let requestData = {};
  
  // 1. 尝试从 event.body 解析（云接入可能会将原生 POST Body 放入 event.body）
  if (event.body) {
    try {
      requestData = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (e) {
      console.error('Parse event.body error:', e);
    }
  }

  // 2. 自适应合并：如果云接入已解包合并至 event 顶级字段，或者为原生云函数调用
  requestData = { ...requestData, ...event };
  // 移除 body 属性，避免混淆
  delete requestData.body;

  const { url: urlPath, method, data } = requestData;
  if (!urlPath) {
    return sendResponse(400, { message: '缺少 url 参数' });
  }

  console.log(`[HTTP Request] Path: ${urlPath}, Method: ${method}`);

  try {
    // 1. GET /api/users (获取角色/用户列表)
    if (urlPath === '/api/users' && method === 'GET') {
      const res = await db.collection('users').limit(100).get();
      return sendResponse(200, res.data);
    }

    // 2. POST /api/users (注册)
    if (urlPath === '/api/users' && method === 'POST') {
      const { name, role, desc } = data || {};
      if (!name || !role) {
        return sendResponse(400, { message: '名字和角色不能为空' });
      }

      const nameTrim = name.trim();
      const descTrim = desc ? desc.trim() : '';
      const phone = descTrim ? descTrim.replace('绑定手机: ', '').trim() : '';

      // 防重复校验
      const nameCheck = await db.collection('users').where({ name: nameTrim }).get();
      if (nameCheck.data.length > 0) {
        return sendResponse(400, { message: '该姓名已被注册，每个账号只能注册一次' });
      }

      if (phone) {
        const phoneCheck = await db.collection('users').where({
          desc: db.RegExp({
            regexp: phone,
            options: 'i'
          })
        }).get();
        if (phoneCheck.data.length > 0) {
          return sendResponse(400, { message: '该手机号已被注册，每个账号只能注册一次' });
        }
      }

      const newUser = {
        name: nameTrim,
        role: role.trim(),
        desc: descTrim
      };

      await db.collection('users').add({ data: newUser });
      return sendResponse(201, newUser);
    }

    // 3. DELETE /api/users/:name (注销账户)
    if (urlPath.startsWith('/api/users/') && method === 'DELETE') {
      const targetName = decodeURIComponent(urlPath.substring('/api/users/'.length));
      const deleteRes = await db.collection('users').where({ name: targetName }).remove();
      if (deleteRes.stats.removed > 0) {
        return sendResponse(200, { message: '注销成功' });
      } else {
        return sendResponse(404, { message: '用户不存在' });
      }
    }

    // 4. GET /api/procurements (获取比价单列表)
    if (urlPath === '/api/procurements' && method === 'GET') {
      const res = await db.collection('procurements').limit(100).get();
      // 根据 ID 降序排列比价单，保证新单据在最上方
      const sortedData = res.data.sort((a, b) => b.id.localeCompare(a.id));
      return sendResponse(200, sortedData);
    }

    // 5. GET /api/procurements/:id (获取比价单详情)
    if (urlPath.startsWith('/api/procurements/') && method === 'GET' && !urlPath.endsWith('/approval')) {
      const id = urlPath.substring('/api/procurements/'.length);
      const res = await db.collection('procurements').where({ id }).get();
      if (res.data.length > 0) {
        return sendResponse(200, res.data[0]);
      } else {
        return sendResponse(404, { message: '单据不存在' });
      }
    }

    // 6. POST /api/procurements (新建比价单)
    if (urlPath === '/api/procurements' && method === 'POST') {
      const body = data || {};
      delete body._id; // 防范 _id 干扰云数据库 add 接口
      await db.collection('procurements').add({ data: body });
      return sendResponse(201, body);
    }

    // 7. PUT /api/procurements/:id (修改比价单)
    if (urlPath.startsWith('/api/procurements/') && method === 'PUT') {
      const id = urlPath.substring('/api/procurements/'.length);
      const body = data || {};
      const docId = body._id;
      delete body._id; // 云开发修改数据不能携带 _id

      let updateRes;
      if (docId) {
        updateRes = await db.collection('procurements').doc(docId).update({ data: body });
      } else {
        updateRes = await db.collection('procurements').where({ id }).update({ data: body });
      }

      if (updateRes.stats.updated > 0) {
        return sendResponse(200, body);
      } else {
        return sendResponse(404, { message: '单据不存在' });
      }
    }

    // 8. POST /api/procurements/:id/approval (审批/驳回)
    if (urlPath.startsWith('/api/procurements/') && urlPath.endsWith('/approval') && method === 'POST') {
      const idPart = urlPath.substring('/api/procurements/'.length);
      const id = idPart.endsWith('/approval') ? idPart.substring(0, idPart.length - '/approval'.length) : idPart;
      const { action, comment, signature, role, userName } = data || {};

      const queryRes = await db.collection('procurements').where({ id }).get();
      if (queryRes.data.length === 0) {
        return sendResponse(404, { message: '单据不存在' });
      }

      const project = queryRes.data[0];
      const now = new Date();
      // 云函数环境处于 UTC 时区，需要转换为 UTC+8 (北京时间)
      const localTime = new Date(now.getTime() + 8 * 3600 * 1000);
      const formattedTime = `${localTime.getUTCFullYear()}-${String(localTime.getUTCMonth()+1).padStart(2,'0')}-${String(localTime.getUTCDate()).padStart(2,'0')} ${String(localTime.getUTCHours()).padStart(2,'0')}:${String(localTime.getUTCMinutes()).padStart(2,'0')}:${String(localTime.getUTCSeconds()).padStart(2,'0')}`;

      const stepIdx = project.approvals.findIndex(a => a.role === role && a.status === 'pending');
      if (stepIdx === -1) {
        return sendResponse(400, { message: '当前无需您审批或您已完成审批' });
      }

      if (action === 'approve') {
        project.approvals[stepIdx] = {
          role,
          status: 'approved',
          userName,
          time: formattedTime,
          comment: comment || '同意确认。',
          signature: signature // 已经转为 CDN 网络图片 URL
        };

        // 推进到下一步
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
        // 驳回逻辑
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

      const docId = project._id;
      delete project._id; // 云开发更新数据不能携带原 _id 属性
      await db.collection('procurements').doc(docId).update({ data: project });

      project._id = docId;
      return sendResponse(200, project);
    }

    // 9. POST /api/upload (手写签名图片转存到云存储并 CDN 化)
    if (urlPath === '/api/upload' && method === 'POST') {
      const { image } = data || {};
      if (!image) {
        return sendResponse(400, { message: '上传数据为空' });
      }

      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `signatures/sig_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`;

      // A. 上传到云存储
      const uploadRes = await cloud.uploadFile({
        cloudPath: filename,
        fileContent: buffer,
      });

      // B. 换取公网 CDN 长期有效访问链接
      const tempFileRes = await cloud.getTempFileURL({
        fileList: [uploadRes.fileID]
      });

      if (tempFileRes.fileList && tempFileRes.fileList.length > 0) {
        const downloadUrl = tempFileRes.fileList[0].tempFileURL;
        return sendResponse(200, { url: downloadUrl });
      } else {
        return sendResponse(500, { message: '换取文件访问链接失败' });
      }
    }

    return sendResponse(404, { message: '路由未找到' });

  } catch (error) {
    console.error('Execute error:', error);
    return sendResponse(500, { message: '服务器内部错误: ' + error.message });
  }
};

function sendResponse(statusCode, data) {
  return {
    statusCode: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(data)
  };
}
