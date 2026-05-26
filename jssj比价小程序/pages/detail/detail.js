const app = getApp();
const { request, upload } = require('../../utils/request.js');

Page({
  data: {
    project: null,
    currentUser: null,
    needMyApproval: false,
    comment: '',
    signatureTyped: false, // 标志用户是否手写签名
    voiceRecording: false, // 语音输入状态
    
    // ✍️ 大屏手写签字弹窗控制
    sigModalActive: false,
    modalSigTyped: false,
    tempSignaturePath: '',

    // 商务条款可见性检测
    hasDeliveryTime: false,
    hasWarranty: false,
    hasPaymentTerm: false,
    hasAnyClause: false,

    totalCosts: [],
    lowestTotalCost: 0,
    lowestSupplierIndex: 0,
    costDiffs: [],
    savings: 0,

    // 字符串格式化数据
    totalCostsFormatted: [],
    costDiffsFormatted: [],
    savingsFormatted: '0.00',
    lowestTotalCostFormatted: '0.00',

    statusTextMap: {
      'pending_engineering': '待工程部确认',
      'pending_project': '待项目部确认',
      'pending_manager': '待部门经理确认',
      'pending_finance': '待财务确认',
      'pending_cashier': '待出纳确认',
      'pending_vgm': '待副总经理确认',
      'pending_gm': '待总经理确认',
      'pending_chairman': '待董事长确认',
      'approved': '确认通过并归档',
      'rejected': '已驳回修改'
    }
  },

  canvasCtx: null,
  isDrawing: false,
  lastX: 0,
  lastY: 0,

  onLoad: function (options) {
    const id = options.id;
    this.projectId = id;
    wx.setNavigationBarTitle({
      title: `采购比价详情 ${app.globalData.version}`
    });
    // 初始化录音监听
    this.initRecorder();
    // 提前初始化手写 Canvas 绘图上下文
    setTimeout(() => {
      this.initModalCanvas();
    }, 450);
  },

  onShow: function () {
    this.loadProjectDetails();
  },

  loadProjectDetails: function () {
    const id = this.projectId;
    const currentUser = app.globalData.currentUser;
    if (!currentUser) return;

    wx.showLoading({ title: '加载中...' });

    request({ url: `/api/procurements/${id}` }).then(project => {
      wx.hideLoading();

      // 1. 判断是否需要当前角色审批
      const needMyApproval = this.checkIfNeedMyApproval(project, currentUser);

      // 2. 检测商务条款是否存在（空白的隐藏）
      const hasDeliveryTime = project.deliveryTime && project.deliveryTime.some(d => d && d.trim() !== '' && d.trim() !== '-');
      const hasWarranty = project.warranty && project.warranty.some(w => w && w.trim() !== '' && w.trim() !== '-');
      const hasPaymentTerm = project.paymentTerm && project.paymentTerm.some(p => p && p.trim() !== '' && p.trim() !== '-');
      const hasAnyClause = hasDeliveryTime || hasWarranty || hasPaymentTerm;

      // 3. 计算报价与高亮
      this.calculateFinancials(project);

      // 4. 判断是否为本人发起的单据，以及当前是否有任何批示 (签字人状态都是pending)
      const isMyProject = currentUser && (currentUser.name === project.creator || currentUser.name.includes(project.creator) || project.creator.includes(currentUser.name));
      const isNoApprovals = project.approvals && project.approvals.every(a => a.status === 'pending');

      this.setData({
        project,
        currentUser,
        needMyApproval,
        hasDeliveryTime,
        hasWarranty,
        hasPaymentTerm,
        hasAnyClause,
        isMyProject,
        isNoApprovals,
        comment: '',
        signatureTyped: false
      });
    }).catch(err => {
      wx.hideLoading();
      console.error(err);
    });
  },

  // 检查是否轮到我确认 (支持姓名与角色双重校验)
  checkIfNeedMyApproval: function (project, currentUser) {
    if (project.status === 'approved' || project.status === 'rejected') {
      return false;
    }
    const nextStep = project.approvals.find(a => a.status === 'pending');
    if (!nextStep) return false;

    // 1. 匹配人名 (例如 "李明" 与 "部门经理-李明" 进行关联)
    if (nextStep.userName && (currentUser.name === nextStep.userName || currentUser.name.includes(nextStep.userName) || nextStep.userName.includes(currentUser.name))) {
      return true;
    }
    // 2. 角色兜底
    if (!nextStep.userName && nextStep.role === currentUser.role) {
      return true;
    }
    return false;
  },

  // 财务统计与高亮计算
  calculateFinancials: function (project) {
    const numSuppliers = project.suppliers.length;
    const items = project.items;

    // 初始化每个参比厂家的总价
    let totalCosts = Array(numSuppliers).fill(0);

    // 首先计算每个物资项目对于不同供应商的单价和合价
    items.forEach(item => {
      let lowestQuote = Infinity;
      item.quotes.forEach((q, supIdx) => {
        const subTotal = (parseFloat(q) || 0) * item.qty;
        totalCosts[supIdx] += subTotal;
        if (q !== '' && q !== undefined && parseFloat(q) < lowestQuote) {
          lowestQuote = parseFloat(q);
        }
      });
      item.lowestQuote = lowestQuote;
      
      // 辅助格式化显示
      item.quotesFormatted = item.quotes.map(q => this.formatNum(q));
      item.subTotalsFormatted = item.quotes.map(q => this.formatNum((parseFloat(q) || 0) * item.qty));
    });

    // 计算总包价里最低的是哪一家
    let lowestTotalCost = Infinity;
    let highestTotalCost = 0;
    let lowestSupplierIndex = 0;

    totalCosts.forEach((cost, idx) => {
      if (cost < lowestTotalCost) {
        lowestTotalCost = cost;
        lowestSupplierIndex = idx;
      }
      if (cost > highestTotalCost) {
        highestTotalCost = cost;
      }
    });

    // 计算各厂家与最低报价的差额
    const costDiffs = totalCosts.map(cost => cost - lowestTotalCost);

    // 节省金额 = 最高总报价 - 最低总报价
    const savings = highestTotalCost - lowestTotalCost;

    this.setData({
      totalCosts,
      lowestTotalCost,
      lowestSupplierIndex,
      costDiffs,
      savings,
      totalCostsFormatted: totalCosts.map(c => this.formatNum(c)),
      costDiffsFormatted: costDiffs.map(d => this.formatNum(d)),
      savingsFormatted: this.formatNum(savings),
      lowestTotalCostFormatted: this.formatNum(lowestTotalCost)
    });
  },

  formatNum: function (num) {
    if (num === '' || num === undefined) return '-';
    return parseFloat(num).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  },

  // ================= ✍️ 大屏手写签字放大弹窗模块 =================

  // 打开大屏签字弹窗
  onOpenSigModal: function () {
    this.setData({
      sigModalActive: true,
      modalSigTyped: false
    });
    // 延迟 200ms 等待全屏弹窗滑入动画稳定、Canvas 容器大小确定后再初始化上下文
    setTimeout(() => {
      this.initModalCanvas();
      if (this.canvasCtx) {
        this.canvasCtx.clearRect(0, 0, 1000, 1000);
        this.canvasCtx.draw();
        this.canvasCtx.setStrokeStyle('#000000');
        this.canvasCtx.setLineWidth(5);
        this.canvasCtx.setLineCap('round');
        this.canvasCtx.setLineJoin('round');
      }
    }, 200);
  },

  // 关闭大屏签字弹窗
  onCloseSigModal: function () {
    this.setData({
      sigModalActive: false
    });
    // 取消关闭时不保存刚刚写的内容，清空大画布以释放临时状态，不影响 tempSignaturePath
    setTimeout(() => {
      if (this.canvasCtx) {
        this.canvasCtx.clearRect(0, 0, 1000, 1000);
        this.canvasCtx.draw();
        this.setData({
          modalSigTyped: false
        });
      }
    }, 200);
  },

  // 初始化大画布
  initModalCanvas: function () {
    const ctx = wx.createCanvasContext('modalSigCanvas', this);
    this.canvasCtx = ctx;

    // 设置画笔初始样式，加粗以方便大屏书写
    ctx.setStrokeStyle('#000000');
    ctx.setLineWidth(5);
    ctx.setLineCap('round');
    ctx.setLineJoin('round');
  },

  // 大画布触摸开始
  onModalTouchStart: function (e) {
    if (!this.canvasCtx) return;
    this.isDrawing = true;
    const { x, y } = e.touches[0];
    this.lastX = x;
    this.lastY = y;
    
    // 强制每次开始触摸都设定画笔粗细与样式，避免因为其他操作重置导致笔迹变细
    this.canvasCtx.setStrokeStyle('#000000');
    this.canvasCtx.setLineWidth(5);
    this.canvasCtx.setLineCap('round');
    this.canvasCtx.setLineJoin('round');

    this.canvasCtx.beginPath();
    this.canvasCtx.moveTo(x, y);
    this.setData({
      modalSigTyped: true
    });
  },

  // 大画布触摸移动
  onModalTouchMove: function (e) {
    if (!this.isDrawing || !this.canvasCtx) return;
    const { x, y } = e.touches[0];
    
    this.canvasCtx.beginPath();
    this.canvasCtx.moveTo(this.lastX, this.lastY);
    this.canvasCtx.lineTo(x, y);
    this.canvasCtx.stroke();
    this.canvasCtx.draw(true); // 连笔丝滑重绘

    this.lastX = x;
    this.lastY = y;
  },

  // 触摸结束
  onModalTouchEnd: function () {
    this.isDrawing = false;
  },

  // 重签/清空大画布
  onClearModalSig: function () {
    if (!this.canvasCtx) return;
    this.canvasCtx.clearRect(0, 0, 1000, 1000);
    this.canvasCtx.draw();
    this.setData({
      modalSigTyped: false
    });
    // 清空重绘后重新设置粗细，绝对防止笔迹变细
    this.canvasCtx.setStrokeStyle('#000000');
    this.canvasCtx.setLineWidth(5);
    this.canvasCtx.setLineCap('round');
    this.canvasCtx.setLineJoin('round');
  },

  // 确定并封装大屏签名图
  onConfirmModalSig: function () {
    if (!this.data.modalSigTyped) {
      wx.showToast({ title: '请在画板中写下您的名字！', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在提取签名印章...' });

    wx.canvasToTempFilePath({
      canvasId: 'modalSigCanvas',
      fileType: 'png',
      success: (res) => {
        wx.hideLoading();
        this.setData({
          tempSignaturePath: res.tempFilePath,
          signatureTyped: true,
          sigModalActive: false
        });
        wx.showToast({ title: '签名提取成功', icon: 'success' });
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('Modal canvas export error:', err);
        wx.showToast({ title: '提取签名图片失败', icon: 'none' });
      }
    }, this);
  },

  onCommentInput: function (e) {
    this.setData({
      comment: e.detail.value
    });
  },

  // ================= 审批提交与驳回核心逻辑 =================

  onSubmitApproval: function (e) {
    const action = e.currentTarget.dataset.action; // 'approve' | 'reject'
    const comment = this.data.comment.trim();

    // 🔒 意见和签字都必须完成，否则提示不完整并进行拦截
    if (!comment) {
      wx.showModal({
        title: '提示',
        content: '审批意见尚未填写，请在上方输入框中写下您的意见说明！',
        showCancel: false
      });
      return;
    }

    if (!this.data.signatureTyped || !this.data.tempSignaturePath) {
      wx.showModal({
        title: '提示',
        content: '手写签字确认尚未完成，请点击签名预览框放大并在大屏幕中书写签字！',
        showCancel: false
      });
      return;
    }

    wx.showLoading({ title: '正在上传签名并提交...' });

    // 先上传手写临时签名，获取真实的网络静态图 URL 后，再提交审批流
    upload(this.data.tempSignaturePath).then(networkUrl => {
      this.processApproval(action, comment, networkUrl);
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '上传签名印章失败', icon: 'none' });
    });
  },

  processApproval: function (action, comment, signaturePath) {
    const role = this.data.currentUser.role;
    const userName = this.data.currentUser.name;

    request({
      url: `/api/procurements/${this.data.project.id}/approval`,
      method: 'POST',
      data: {
        action,
        comment,
        signature: signaturePath,
        role,
        userName
      }
    }).then(() => {
      wx.hideLoading();
      wx.showToast({
        title: action === 'approve' ? '已签字确认通过' : '已驳回该比价单',
        icon: 'success',
        duration: 1500,
        success: () => {
          setTimeout(() => {
            this.loadProjectDetails();
          }, 1500);
        }
      });
    }).catch(() => {
      wx.hideLoading();
    });
  },

  onExportReport: function () {
    wx.navigateTo({
      url: `/pages/report/report?id=${this.data.project.id}`
    });
  },

  // 发起人撤回审批
  onWithdrawProject: function () {
    wx.showModal({
      title: '确认撤回',
      content: '撤回后，该单据将被重置为“草稿”状态，所有已作出的签字批示均会被清空。您确定要撤回吗？',
      success: (res) => {
        if (res.confirm) {
          const project = { ...this.data.project };
          project.status = 'draft';
          project.approvals = project.approvals.map(a => {
            return {
              ...a,
              status: 'pending',
              time: '',
              comment: '',
              signature: ''
            };
          });

          wx.showLoading({ title: '正在撤销送审...' });
          request({
            url: `/api/procurements/${project.id}`,
            method: 'PUT',
            data: project
          }).then(() => {
            wx.hideLoading();
            wx.showToast({
              title: '单据已成功撤回',
              icon: 'success',
              success: () => {
                this.loadProjectDetails();
              }
            });
          }).catch(() => {
            wx.hideLoading();
          });
        }
      }
    });
  },

  // 发起人修改并重新发起
  onEditProject: function () {
    wx.navigateTo({
      url: `/pages/create/create?id=${this.data.project.id}`
    });
  },

  // ================= 语音录入 =================
  initRecorder: function () {
    const recorderManager = wx.getRecorderManager();
    recorderManager.onStop((res) => {
      const field = this.voiceTargetField;
      let recognizedText = "";

      if (res.tempFilePath) {
        if (wx.translateVoice) {
          wx.translateVoice({
            filePath: res.tempFilePath,
            success: (transRes) => {
              recognizedText = transRes.result || "";
              this.fillRecognizedText(field, recognizedText);
            },
            fail: () => {
              wx.showToast({ title: '语音识别失败，请清晰重试', icon: 'none' });
            }
          });
          return;
        }
      }
      
      wx.showToast({ title: '当前环境不支持语音转文字', icon: 'none' });
    });
  },

  fillRecognizedText: function (field, text) {
    if (!text) return;
    
    wx.showToast({
      title: '语音转文字成功',
      icon: 'success'
    });

    if (field === 'comment') {
      this.setData({ comment: text });
    }
  },

  onStartVoice: function (e) {
    const field = e.currentTarget.dataset.field;
    this.voiceTargetField = field;

    wx.getSetting({
      success: (res) => {
        if (!res.authSetting['scope.record']) {
          wx.authorize({
            scope: 'scope.record',
            success: () => {
              this.startRecording();
            },
            fail: () => {
              wx.showModal({
                title: '麦克风授权失败',
                content: '语音录入功能需要麦克风录音权限，请在小程序设置页中开启“麦克风”授权。',
                confirmText: '去设置',
                success: (modalRes) => {
                  if (modalRes.confirm) {
                    wx.openSetting();
                  }
                }
              });
            }
          });
        } else {
          this.startRecording();
        }
      }
    });
  },

  startRecording: function () {
    const recorderManager = wx.getRecorderManager();
    recorderManager.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 96000,
      format: 'mp3'
    });

    this.setData({
      voiceRecording: true
    });
  },

  onStopVoice: function () {
    const recorderManager = wx.getRecorderManager();
    recorderManager.stop();
    this.setData({
      voiceRecording: false
    });
  }
});
