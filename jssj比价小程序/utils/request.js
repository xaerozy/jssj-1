function request(options) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'api',
      data: {
        action: options.action || options.url,
        url: options.url || options.action,
        method: options.method || 'POST',
        data: options.data
      },
      success: (res) => {
        let result = res.result;
        let responseData = result;
        let statusCode = 200;

        // 兼容云接入未开启集成响应模式时，自定义状态码和body会作为普通JSON字段返回的情况
        if (result && typeof result === 'object' && 'statusCode' in result && 'body' in result) {
          statusCode = result.statusCode;
          try {
            responseData = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
          } catch (e) {
            responseData = result.body;
          }
        }

        // 如果最终确定的状态码在 200-299 范围内
        if (statusCode >= 200 && statusCode < 300) {
          resolve(responseData);
        } else {
          wx.showModal({
            title: '操作失败',
            content: (responseData && responseData.message) || '请求出错了，请稍后重试',
            showCancel: false
          });
          reject(responseData);
        }
      },
      fail: (err) => {
        wx.showModal({
          title: '连接失败',
          content: '调用云开发服务失败，请确认云函数已部署且网络正常！',
          showCancel: false
        });
        reject(err);
      }
    });
  });
}


function upload(filePath) {
  return new Promise((resolve, reject) => {
    // 使用微信文件系统将临时签名图片读取为 Base64 格式发送
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: filePath,
      encoding: 'base64',
      success: (res) => {
        const base64Data = res.data;
        request({
          url: '/api/upload',
          method: 'POST',
          data: {
            image: `data:image/png;base64,${base64Data}`
          }
        }).then(res => {
          resolve(res.url); // 返回微信云存储 CDN 临时链接 URL
        }).catch(err => {
          reject(err);
        });
      },
      fail: (err) => {
        console.error('Read file fail:', err);
        wx.showToast({ title: '读取签名文件失败', icon: 'none' });
        reject(err);
      }
    });
  });
}

module.exports = {
  request,
  upload
};
