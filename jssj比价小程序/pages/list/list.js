const app = getApp();
const { request } = require('../../utils/request.js');

Page({
  data: {
    currentUser: null,
    procurementList: [],
    filteredList: [],
    activeTab: 'pending', // 'pending' | 'all' | 'approved'
    searchQuery: '', // 🔍 搜索关键词
    stats: {
      pendingCount: 0,
      totalCount: 0,
      approvedCount: 0
    },
    refreshing: false,
    statusTextMap: {
      'pending_engineering': '待工程部确认',
      'pending_project': '待项目部确认',
      'pending_manager': '待部门经理确认',
      'pending_gm': '待总经理确认',
      'pending_finance': '待财务总监确认',
      'approved': '已通过(归档)',
      'rejected': '已驳回'
    }
  },

  onLoad: function () {
    // 设置带版本号的标题
    wx.setNavigationBarTitle({
      title: `比价申请列表 ${app.globalData.version}`
    });
    // 检查登录状态
    this.checkLoginStatus();
  },

  onShow: function () {
    // 每次显示页面时，重新拉取最新数据（防止从详情页审批后返回列表不刷新）
    if (app.globalData.currentUser) {
      this.setData({
        currentUser: app.globalData.currentUser
      });
      this.fetchProcurements();
    }
  },

  fetchProcurements: function () {
    return request({ url: '/api/procurements' }).then(list => {
      this.setData({
        procurementList: list
      });
      this.calculateStats();
      this.filterList();
    }).catch(err => {
      console.error('获取比价单列表失败', err);
    });
  },

  checkLoginStatus: function () {
    if (!app.globalData.currentUser) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
    } else {
      this.setData({
        currentUser: app.globalData.currentUser
      });
    }
  },

  // 计算不同 Tab 的统计数量
  calculateStats: function () {
    const list = this.data.procurementList;
    const user = this.data.currentUser;

    let pendingCount = 0;
    let totalCount = list.length;
    let approvedCount = 0;

    list.forEach(item => {
      // 检查当前是否属于当前登录人的待审批件 (传入user实例进行人名+角色校验)
      const needMyApproval = this.checkIfNeedMyApproval(item, user);
      if (needMyApproval) {
        pendingCount++;
      }
      if (item.status === 'approved') {
        approvedCount++;
      }
    });

    this.setData({
      stats: {
        pendingCount,
        totalCount,
        approvedCount
      }
    });
  },

  // 判断此单目前是否正等待该用户签字确认 (支持姓名与角色双重校验)
  checkIfNeedMyApproval: function (item, currentUser) {
    if (item.status === 'approved' || item.status === 'rejected' || item.status === 'draft') {
      return false;
    }
    const nextStep = item.approvals.find(a => a.status === 'pending');
    if (!nextStep) return false;

    // 1. 优先匹配具体人名 (支持全等及包含关系)
    if (nextStep.userName && currentUser) {
      if (currentUser.name === nextStep.userName || currentUser.name.includes(nextStep.userName) || nextStep.userName.includes(currentUser.name)) {
        return true;
      }
    }
    // 2. 角色兜底 (兼容老旧测试数据)
    if (!nextStep.userName && currentUser && nextStep.role === currentUser.role) {
      return true;
    }
    return false;
  },

  // 过滤数据列表
  filterList: function () {
    const list = this.data.procurementList;
    const tab = this.data.activeTab;
    const user = this.data.currentUser;
    const query = this.data.searchQuery.trim().toLowerCase();

    let filtered = [];

    // 1. 按状态 Tab 类别进行过滤
    if (tab === 'pending') {
      filtered = list.filter(item => this.checkIfNeedMyApproval(item, user));
    } else if (tab === 'approved') {
      filtered = list.filter(item => item.status === 'approved');
    } else {
      filtered = list;
    }

    // 2. 🔍 多维模糊检索 (支持：项目名称、时间、金额、供应商名称、采购内容)
    if (query) {
      filtered = filtered.filter(item => {
        const matchTitle = item.title.toLowerCase().includes(query);
        const matchTime = item.createTime.toLowerCase().includes(query);
        const matchSuppliers = item.suppliers.some(s => s.toLowerCase().includes(query));
        const matchItems = item.items.some(i => i.name.toLowerCase().includes(query));
        
        // 金额维度：计算各参比供应商总包成本，检查其总价字面量是否符合输入
        const matchAmount = item.items.reduce((acc, cur) => {
          return acc || cur.quotes.some((q, idx) => {
            const totalForSup = item.items.reduce((sum, it) => sum + (parseFloat(it.quotes[idx]) || 0) * it.qty, 0);
            return totalForSup.toString().includes(query) || totalForSup.toFixed(2).includes(query);
          });
        }, false);

        return matchTitle || matchTime || matchSuppliers || matchItems || matchAmount;
      });
    }

    // 3. 格式化展示的文本
    const formatted = filtered.map(item => {
      let shortNames = item.suppliers.slice(0, 2).join(' / ');
      if (item.suppliers.length > 2) {
        shortNames += `等${item.suppliers.length}家`;
      }

      const itemSummaryText = item.items.map(i => `${i.name}*${i.qty}${i.unit}`).join(', ');

      return {
        ...item,
        supplierNamesShort: shortNames,
        itemSummaryText: itemSummaryText,
        needMyApproval: this.checkIfNeedMyApproval(item, user)
      };
    });

    this.setData({
      filteredList: formatted
    });
  },

  // 搜索输入触发
  onSearchInput: function (e) {
    this.setData({
      searchQuery: e.detail.value
    });
    this.filterList();
  },

  // 清除搜索
  onClearSearch: function () {
    this.setData({
      searchQuery: ''
    });
    this.filterList();
  },

  // 状态 Tab 切换
  onTabChange: function (e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      activeTab: tab
    });
    this.filterList();
  },

  // 顶部统计块点击触发过滤
  onSelectFilter: function (e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({
      activeTab: tab
    });
    this.filterList();
  },

  // 查看详情
  onViewDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    });
  },

  // 新建比价单
  onCreateNew: function () {
    wx.navigateTo({
      url: '/pages/create/create'
    });
  },

  // 下拉刷新
  onRefresh: function () {
    this.setData({ refreshing: true });
    this.fetchProcurements().then(() => {
      this.setData({ refreshing: false });
      wx.showToast({
        title: '已更新最新列表',
        icon: 'none'
      });
    }).catch(() => {
      this.setData({ refreshing: false });
    });
  },

  // 切换账号（退出登录）
  onLogout: function () {
    wx.showModal({
      title: '提示',
      content: '确定要切换登录账号吗？',
      success: (res) => {
        if (res.confirm) {
          app.globalData.currentUser = null;
          wx.removeStorageSync('current_user');
          wx.reLaunch({
            url: '/pages/login/login'
          });
        }
      }
    });
  }
});
