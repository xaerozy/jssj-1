App({
  globalData: {
    currentUser: null, // 当前登录用户，格式：{ name: '王经理', role: '部门经理' }
    version: 'V2.00', // 版本号
    env: 'release'
  },

  onLaunch: function () {
    // 初始化云开发
    wx.cloud.init({
      env: 'cloud1-d3ge768eac2c784dd', // 你的环境ID
      traceUser: true,
    });

    let env = 'release';
    try {
      env = wx.getAccountInfoSync().miniProgram.envVersion || 'release';
    } catch (e) {
      console.error('getAccountInfoSync fail:', e);
    }
    this.globalData.env = env;

    // 尝试从本地恢复上一次登录的用户
    const user = wx.getStorageSync('current_user');
    if (user) {
      this.globalData.currentUser = user;
    }
  }
});
