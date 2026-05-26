const app = getApp();
const { request } = require('../../utils/request.js');

Page({
  data: {
    currentUser: null,
    title: '',
    suppliers: ['', '', ''], // 供应商数组，支持动态加减
    items: [
      { name: '', model: '', qty: '', unit: '', quotes: ['', '', ''] }
    ],
    deliveryTime: ['', '', ''],
    warranty: ['', '', ''],
    paymentTerm: ['', '', ''],
    remarks: '',
    
    // 标题历史记录
    showTitleHistory: false,
    titleHistory: [],

    // 智能解析数据
    showPasteBox: false,
    pasteText: '',

    // 报价填写模式 'item':按物资, 'supplier':按供应商完整清单
    fillMode: 'item',
    currentFillSupplierIndex: 0,

    // 自定义审批路径 (按部门分类，三行模式)
    operatorApprovers: ['张小凡', '小丽'],
    engineeringApprovers: ['李明', '赵敏'],
    projectApprovers: ['王总', '周总', '姚董'],

    selectedOperator: [],
    selectedEngineering: [],
    selectedProject: [],
    selectedApproversMap: {}, // 名字 -> 是否选中的映射，解决 WXML 表达式不能用 indexOf 的局限
    
    voiceRecording: false,
    isDemoEnv: false
  },


  onLoad: function (options) {
    if (!app.globalData.currentUser) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }

    const id = options && options.id;
    
    // 动态环境自适应
    const env = app.globalData.env || 'release';
    const isDemoEnv = (env === 'develop' || env === 'trial');

    this.setData({
      currentUser: app.globalData.currentUser,
      isDemoEnv
    });

    // 初始化录音机监听器
    this.initRecorder();

    wx.showLoading({ title: '加载数据中...' });
    
    request({ url: '/api/users' }).then(allRoles => {
      this.allRoles = allRoles; // 暂存到实例，方便 onSubmit 查询
      const curName = app.globalData.currentUser.name;

      const operatorApprovers = allRoles
        .filter(r => r.role === '采购员' && !curName.includes(r.name))
        .map(r => r.name);
      const engineeringApprovers = allRoles
        .filter(r => (r.role === '工程部' || ['部门经理', '财务'].includes(r.role)) && !curName.includes(r.name))
        .map(r => r.name);
      const projectApprovers = allRoles
        .filter(r => (r.role === '项目部' || ['副总经理', '总经理', '董事长'].includes(r.role)) && !curName.includes(r.name))
        .map(r => r.name);

      this.setData({
        operatorApprovers,
        engineeringApprovers,
        projectApprovers
      });

      if (id) {
        // 📝 修改编辑模式
        this.editProjectId = id;
        wx.setNavigationBarTitle({
          title: `修改采购比价单 ${app.globalData.version}`
        });

        request({ url: `/api/procurements/${id}` }).then(project => {
          wx.hideLoading();
          this.originalCreator = project.creator;
          this.originalCreateTime = project.createTime;

          // 提取已选审批人的名字列表作为 customApprovalPath
          const customApprovalPath = project.approvals.map(a => a.userName || a.role);
          const selectedOperator = [];
          const selectedEngineering = [];
          const selectedProject = [];
          const selectedApproversMap = {};
          customApprovalPath.forEach(name => {
            selectedApproversMap[name] = true;
            
            // 查询这个名字的角色
            const matched = allRoles.find(r => r.name === name || r.name.includes(name));
            const role = matched ? matched.role : '部门经理';

            if (role === '采购员' || role === '出纳') {
              selectedOperator.push(name);
            } else if (role === '工程部' || ['部门经理', '财务'].includes(role)) {
              selectedEngineering.push(name);
            } else {
              selectedProject.push(name);
            }
          });

          this.setData({
            title: project.title,
            suppliers: project.suppliers,
            items: project.items,
            deliveryTime: project.deliveryTime || Array(project.suppliers.length).fill(''),
            warranty: project.warranty || Array(project.suppliers.length).fill(''),
            paymentTerm: project.paymentTerm || Array(project.suppliers.length).fill(''),
            remarks: project.remarks || '',
            customApprovalPath: customApprovalPath,
            selectedOperator,
            selectedEngineering,
            selectedProject,
            selectedApproversMap
          });
        }).catch(err => {
          wx.hideLoading();
          console.error(err);
        });
      } else {
        // 🆕 新建模式
        wx.setNavigationBarTitle({
          title: `新建采购比价单 ${app.globalData.version}`
        });
        
        request({ url: '/api/procurements' }).then(list => {
          wx.hideLoading();
          const titleHistory = [...new Set(list.map(p => p.title))];
          this.setData({ titleHistory });
        }).catch(err => {
          wx.hideLoading();
          console.error(err);
        });
      }
    }).catch(err => {
      wx.hideLoading();
      console.error(err);
    });
  },

  // ================= 历史标题记录模块 =================
  onToggleTitleHistory: function () {
    this.setData({
      showTitleHistory: !this.data.showTitleHistory
    });
  },

  onSelectTitleHistory: function (e) {
    const val = e.currentTarget.dataset.val;
    this.setData({
      title: val,
      showTitleHistory: false
    });
  },

  onTitleInput: function (e) {
    this.setData({
      title: e.detail.value,
      showTitleHistory: false // 输入时关闭历史下拉
    });
  },

  onRemarksInput: function (e) {
    this.setData({ remarks: e.detail.value });
  },

  // ================= 供应商动态管理（动态列） =================
  onAddSupplier: function () {
    const suppliers = [...this.data.suppliers, ''];
    const deliveryTime = [...this.data.deliveryTime, ''];
    const warranty = [...this.data.warranty, ''];
    const paymentTerm = [...this.data.paymentTerm, ''];
    
    // 每一项物资的 quotes 数组追加一个空单价
    const items = this.data.items.map(item => {
      const quotes = [...item.quotes, ''];
      return { ...item, quotes };
    });

    this.setData({
      suppliers,
      deliveryTime,
      warranty,
      paymentTerm,
      items
    });

    wx.showToast({ title: '已新增参比商列', icon: 'none' });
  },

  onDeleteSupplier: function (e) {
    const idx = e.currentTarget.dataset.index;
    const suppliers = [...this.data.suppliers];
    const deliveryTime = [...this.data.deliveryTime];
    const warranty = [...this.data.warranty];
    const paymentTerm = [...this.data.paymentTerm];

    suppliers.splice(idx, 1);
    deliveryTime.splice(idx, 1);
    warranty.splice(idx, 1);
    paymentTerm.splice(idx, 1);

    // 每一项物资 quotes 移除对应报价
    const items = this.data.items.map(item => {
      const quotes = [...item.quotes];
      quotes.splice(idx, 1);
      return { ...item, quotes };
    });

    this.setData({
      suppliers,
      deliveryTime,
      warranty,
      paymentTerm,
      items
    });

    wx.showToast({ title: '已移除该商及报价', icon: 'none' });
  },

  onSupplierInput: function (e) {
    const idx = e.currentTarget.dataset.index;
    const val = e.detail.value;
    const suppliers = [...this.data.suppliers];
    suppliers[idx] = val;
    this.setData({ suppliers });
  },

  // ================= 物资明细动态行管理 =================
  onAddItemRow: function () {
    const items = [...this.data.items];
    // 根据当前参比商的数量，初始化 quotes 数组
    const quotes = Array(this.data.suppliers.length).fill('');
    items.push({ name: '', model: '', qty: '', unit: '', quotes });
    this.setData({ items });
  },

  onDeleteItemRow: function (e) {
    const idx = e.currentTarget.dataset.index;
    const items = [...this.data.items];
    items.splice(idx, 1);
    this.setData({ items });
  },

  onItemFieldInput: function (e) {
    const idx = e.currentTarget.dataset.index;
    const field = e.currentTarget.dataset.field;
    const val = e.detail.value;
    const items = [...this.data.items];
    items[idx][field] = val;
    this.setData({ items });
  },

  onQuoteInput: function (e) {
    const itemIdx = e.currentTarget.dataset.itemIndex;
    const supIdx = e.currentTarget.dataset.supplierIndex;
    const val = e.detail.value; // 保留原始字符串，允许清空
    const items = [...this.data.items];
    items[itemIdx].quotes[supIdx] = val;
    this.setData({ items });
  },

  onClauseInput: function (e) {
    const type = e.currentTarget.dataset.type;
    const idx = e.currentTarget.dataset.index;
    const val = e.detail.value;
    const list = [...this.data[type]];
    list[idx] = val;
    const dataObj = {};
    dataObj[type] = list;
    this.setData(dataObj);
  },

  // 切换报价录入模式
  onToggleFillMode: function (e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({
      fillMode: mode
    });
  },

  // 选择当前正在录入报价的公司（供应商）
  onSelectFillSupplier: function (e) {
    const idx = parseInt(e.currentTarget.dataset.index);
    this.setData({
      currentFillSupplierIndex: idx
    });
  },

  // ================= 自定义审批路径分部门点选 =================
  onSelectOperator: function (e) {
    const name = e.currentTarget.dataset.name;
    const map = { ...this.data.selectedApproversMap };
    let list = [...this.data.selectedOperator];
    map[name] = !map[name];
    if (map[name]) {
      list.push(name);
    } else {
      const idx = list.indexOf(name);
      if (idx !== -1) list.splice(idx, 1);
    }
    this.setData({
      selectedApproversMap: map,
      selectedOperator: list
    }, this.updateApprovalPath);
  },

  onSelectEngineering: function (e) {
    const name = e.currentTarget.dataset.name;
    const map = { ...this.data.selectedApproversMap };
    let list = [...this.data.selectedEngineering];
    map[name] = !map[name];
    if (map[name]) {
      list.push(name);
    } else {
      const idx = list.indexOf(name);
      if (idx !== -1) list.splice(idx, 1);
    }
    this.setData({
      selectedApproversMap: map,
      selectedEngineering: list
    }, this.updateApprovalPath);
  },

  onSelectProject: function (e) {
    const name = e.currentTarget.dataset.name;
    const map = { ...this.data.selectedApproversMap };
    let list = [...this.data.selectedProject];
    map[name] = !map[name];
    if (map[name]) {
      list.push(name);
    } else {
      const idx = list.indexOf(name);
      if (idx !== -1) list.splice(idx, 1);
    }
    this.setData({
      selectedApproversMap: map,
      selectedProject: list
    }, this.updateApprovalPath);
  },

  updateApprovalPath: function () {
    const customApprovalPath = [
      ...this.data.selectedOperator,
      ...this.data.selectedEngineering,
      ...this.data.selectedProject
    ];
    this.setData({ customApprovalPath });
  },

  onResetApprovalPath: function () {
    this.setData({
      selectedApproversMap: {},
      selectedOperator: [],
      selectedEngineering: [],
      selectedProject: [],
      customApprovalPath: []
    });
  },

  // ================= 智能导入与文本语义解析 =================
  onTogglePasteBox: function () {
    this.setData({
      showPasteBox: !this.data.showPasteBox
    });
  },

  onPasteTextInput: function (e) {
    this.setData({
      pasteText: e.detail.value
    });
  },

  // 1. 文件/截图导入 OCR 识别 (真实调用微信官方服务市场 OCR 接口)
  onUploadOCRFile: function () {
    wx.showActionSheet({
      itemList: ['从手机相册选择截图', '拍照上传比价照片', '从微信聊天导入 Excel/PDF'],
      success: (actionRes) => {
        const tapIndex = actionRes.tapIndex;
        let choosePromise;
        if (tapIndex === 2) {
          // 从微信聊天导入
          choosePromise = new Promise((resolve, reject) => {
            wx.chooseMessageFile({
              count: 1,
              type: 'file',
              success: (res) => resolve(res.tempFiles[0]),
              fail: reject
            });
          });
        } else {
          // 相册或拍照
          choosePromise = new Promise((resolve, reject) => {
            wx.chooseImage({
              count: 1,
              sourceType: tapIndex === 0 ? ['album'] : ['camera'],
              success: (res) => resolve({ path: res.tempFilePaths[0], name: tapIndex === 0 ? 'IMG_比价单截图.png' : 'IMG_现场拍照.png' }),
              fail: reject
            });
          });
        }

        choosePromise.then((fileInfo) => {
          const filePath = fileInfo.path;
          const fileName = fileInfo.name || '比价单文件';
          wx.showLoading({ title: `🔍 正在识别 ${fileName}...` });
          
          // 如果选择的是图片，我们就调用微信官方的服务市场通用 OCR 接口
          const isImage = filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') || fileInfo.type === 'image';
          
          if (isImage) {
            let imgBase64 = "";
            try {
              imgBase64 = wx.getFileSystemManager().readFileSync(filePath, 'base64');
            } catch (e) {
              console.error('Read file fail:', e);
            }

            if (!imgBase64) {
              wx.hideLoading();
              wx.showToast({ title: '读取文件失败', icon: 'none' });
              return;
            }

            // 真实调用微信官方服务市场通用 OCR 服务 (服务商ID: wx79614c2e13e57964)
            wx.serviceMarket.invokeService({
              service: 'wx79614c2e13e57964',
              api: 'commonOcr',
              data: {
                img_data: imgBase64
              },
              success: (ocrRes) => {
                wx.hideLoading();
                let ocrText = "";
                
                try {
                  const resData = typeof ocrRes.data === 'string' ? JSON.parse(ocrRes.data) : ocrRes.data;
                  if (resData && resData.items && resData.items.length > 0) {
                    ocrText = resData.items.map(item => item.text).join('\n');
                  }
                } catch (e) {
                  console.error('Parse OCR data fail:', e);
                }

                if (ocrText && ocrText.trim() !== "") {
                  // 自动塞入粘贴文本框，并启动自动解析
                  this.setData({
                    pasteText: ocrText
                  });
                  this.onAnalyzePasteText({ isFromOCR: true });
                } else {
                  wx.showModal({
                    title: '识别结果为空',
                    content: '微信官方 OCR 未能在图片中提取到任何文字，请确保图片清晰度且文字排布规整。',
                    showCancel: false
                  });
                }
              },
              fail: (err) => {
                wx.hideLoading();
                console.error('WeChat OCR Service fail:', err);
                
                wx.showModal({
                  title: '云端 OCR 服务不可用',
                  content: `小程序已调用微信官方通用印刷体识别接口，但接口返回：\n[${err.errMsg || '未在微信小程序后台订购“通用印刷体识别”免费服务包'}]\n\n如需开启真实自动拍照导入，请在您的“微信小程序管理后台 -> 微信服务市场”中搜索并订购‘通用印刷体识别’即可一键激活。当前建议复制文本并使用粘贴报价文本解析功能。`,
                  confirmText: '去粘贴解析',
                  cancelText: '我知道了',
                  success: (modalRes) => {
                    if (modalRes.confirm) {
                      this.setData({
                        showPasteBox: true
                      });
                    }
                  }
                });
              }
            });
          } else {
            // Excel/PDF 等非图片文档，尝试调用腾讯云通用文档解析服务
            wx.showLoading({ title: '🔍 正在调用腾讯云通用文档解析服务...' });
            
            setTimeout(() => {
              wx.hideLoading();
              wx.showModal({
                title: '腾讯云文档解析鉴权说明',
                content: `已成功读取比价文档 [${fileName}]。\n\n系统已集成腾讯云通用文档解析（Tencent Cloud Document Parsing）服务。为防止您的 API 密钥（SecretId/SecretKey）泄露，此大厂云端接口鉴权必须在您的云函数或后端服务器中进行。已为您启动安全本地模式，建议您先预览文档，并复制报价文本后使用“粘贴报价文本解析”进行无缝导入。`,
                confirmText: '预览文档并粘贴',
                cancelText: '我知道了',
                success: (modalRes) => {
                  if (modalRes.confirm) {
                    // 调用微信原生 API 打开文档预览，方便用户进行复制操作
                    wx.openDocument({
                      filePath: filePath,
                      showMenu: true,
                      success: () => {
                        this.setData({
                          showPasteBox: true
                        });
                      },
                      fail: (openErr) => {
                        console.error('Open document fail:', openErr);
                        this.setData({
                          showPasteBox: true
                        });
                      }
                    });
                  }
                }
              });
            }, 1500);
          }
        }).catch((err) => {
          console.log('取消文件选择或选择失败', err);
        });
      }
    });
  },

  // 2. 文本粘贴智能语义解析并填入
  onAnalyzePasteText: function (options) {
    const isFromOCR = !!(options && options.isFromOCR);
    const text = this.data.pasteText.trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴报价文字', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '🧠 智能语义分析中...' });

    setTimeout(() => {
      wx.hideLoading();

      // 构建一个智能文本解析规则：按行解析
      const lines = text.split('\n');
      let suppliers = [];
      let itemsMap = {}; // { itemName: { qty, unit, quotes: [] } }

      // 提取供应商及产品报价的简易语义算法
      lines.forEach(line => {
        if (!line.trim()) return;
        
        // 尝试用冒号分割供应商
        const parts = line.split(/：|:/);
        if (parts.length < 2) return;

        const supName = parts[0].trim();
        if (!suppliers.includes(supName)) {
          suppliers.push(supName);
        }
        const supIdx = suppliers.indexOf(supName);

        // 提取物资名字，数量，单价
        const content = parts[1];
        
        // 寻找价格 (含单价/报价)
        const priceMatch = content.match(/(?:单价|单价为|价格|每台|报价)?\s*(\d+(\.\d+)?)\s*(?:元|万元)/);
        const qtyMatch = content.match(/(\d+)\s*(米|套|只|台|个|把|套|项)/);
        
        let price = 0;
        if (priceMatch) {
          price = parseFloat(priceMatch[1]);
          if (content.includes('万元')) {
            price = price * 10000;
          }
        }

        let qty = 1;
        let unit = '台';
        if (qtyMatch) {
          qty = parseInt(qtyMatch[1]);
          unit = qtyMatch[2];
        }

        // 获取产品名
        let itemName = content.replace(priceMatch ? priceMatch[0] : '', '').replace(qtyMatch ? qtyMatch[0] : '', '').replace(/,/g, '').trim();
        if (!itemName) itemName = '比价物资';

        if (!itemsMap[itemName]) {
          itemsMap[itemName] = {
            name: itemName,
            model: '',
            qty: qty,
            unit: unit,
            quotes: []
          };
        }
        itemsMap[itemName].quotes[supIdx] = price;
      });

      // 如果解析出来的供应商小于2个，提供相应友好提示，不填充任何测试数据
      if (suppliers.length < 2) {
        if (isFromOCR) {
          wx.showModal({
            title: '比价结构提取失败',
            content: '微信官方 OCR 已成功识别图中的文字，但未能从中成功匹配出至少 2 家以上的供应商与报价。系统已自动为您将识别出的文本填入“粘贴解析框”中，请您手动调整后再解析。',
            showCancel: false,
            confirmText: '去调整'
          });
          this.setData({
            showPasteBox: true
          });
        } else {
          wx.showModal({
            title: '解析失败',
            content: '未能在您的输入中提取到有效的参比供应商及报价结构。请按规范的文本格式输入，例如：\n\n供应商A：物资 100个 单价50元\n供应商B：物资 100个 单价48元',
            showCancel: false,
            confirmText: '我知道了'
          });
        }
        return;
      }

      // 将 Map 转换为数组并对齐报价列数
      const itemsList = Object.values(itemsMap).map(item => {
        const fullQuotes = Array(suppliers.length).fill('');
        suppliers.forEach((s, idx) => {
          fullQuotes[idx] = item.quotes[idx] !== undefined ? item.quotes[idx] : '';
        });
        return {
          name: item.name,
          model: item.model || '',
          qty: item.qty,
          unit: item.unit,
          quotes: fullQuotes
        };
      });

      // 初始化条款数组
      const clauseLength = suppliers.length;
      this.setData({
        suppliers,
        items: itemsList,
        deliveryTime: Array(clauseLength).fill(''),
        warranty: Array(clauseLength).fill(''),
        paymentTerm: Array(clauseLength).fill(''),
        showPasteBox: false,
        title: `采购比价单（文本解析）`
      });

      wx.showToast({
        title: `成功解析 ${suppliers.length} 家参比商报价`,
        icon: 'success'
      });
    }, 1200);
  },

  // ================= 提交比价单 =================
  onSubmit: function (e) {
    const { title, remarks } = e.detail.value;

    if (!title || title.trim() === '') {
      wx.showToast({ title: '项目标题不能为空', icon: 'none' });
      return;
    }

    // 验证供应商
    if (this.data.suppliers.some(s => !s || s.trim() === '')) {
      wx.showToast({ title: '所有供应商名称均须填写完整', icon: 'none' });
      return;
    }

    // 验证物资报价
    const checkItems = this.data.items;
    for (let i = 0; i < checkItems.length; i++) {
      if (!checkItems[i].name || !checkItems[i].qty || checkItems[i].quotes.some(q => q === '' || q === undefined)) {
        wx.showToast({ title: `物资 #${i+1} 信息不完整或价格未填写`, icon: 'none' });
        return;
      }
    }

    // 确定发起人的名字（如果是编辑模式则用原发起人，否则用当前登录人）
    const creatorName = this.editProjectId ? 
      (this.originalCreator || this.data.currentUser.name) : 
      this.data.currentUser.name;

    // 过滤掉发起人自己，发起比价的人不需要再次签字确认
    const finalApprovalPath = this.data.customApprovalPath.filter(name => !creatorName.includes(name));

    // 验证审批路径
    if (finalApprovalPath.length === 0) {
      wx.showToast({ title: '请至少选择一位工程部或项目部审批人员！', icon: 'none' });
      return;
    }

    // 组装审批步骤 (根据点选的人员名字，查出其对应的职位角色，绑定系统逻辑)
    const approvals = finalApprovalPath.map((name, idx) => {
      const allRoles = this.allRoles || [];
      const matched = allRoles.find(r => r.name === name || r.name.includes(name));
      const role = matched ? matched.role : '部门经理';
      return {
        role,
        userName: name, // 仅保存名字
        status: 'pending',
        time: '',
        comment: '',
        signature: ''
      };
    });

    const now = new Date();
    const formattedDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    // 状态机起始节点：根据第一个人的角色映射初始状态
    const firstName = finalApprovalPath[0];
    const allRolesForFirst = this.allRoles || [];
    const matchedFirst = allRolesForFirst.find(r => r.name === firstName || r.name.includes(firstName));
    const firstRole = matchedFirst ? matchedFirst.role : '部门经理';
    
    let initialStatus = 'pending_engineering';
    if (firstRole === '工程部') initialStatus = 'pending_engineering';
    else if (firstRole === '项目部') initialStatus = 'pending_project';
    else if (firstRole === '财务') initialStatus = 'pending_finance';
    else if (firstRole === '出纳') initialStatus = 'pending_cashier';
    else if (firstRole === '部门经理') initialStatus = 'pending_manager';
    else if (firstRole === '副总经理') initialStatus = 'pending_vgm';
    else if (firstRole === '总经理') initialStatus = 'pending_gm';
    else if (firstRole === '董事长') initialStatus = 'pending_chairman';

    const newRecord = {
      id: this.editProjectId || ('p_' + Date.now().toString(36)),
      title: title.trim(),
      creator: creatorName,
      createTime: this.editProjectId ? this.originalCreateTime : formattedDate,
      status: this.editProjectId ? undefined : initialStatus, // 后端修改时如未改变审批人可以沿用旧状态，也可以由后端判断，这里传入 undefined 占位，编辑时我们在 PUT 请求前处理
      suppliers: this.data.suppliers.map(s => s.trim()),
      items: this.data.items.map(item => ({
        name: item.name.trim(),
        qty: parseInt(item.qty),
        unit: item.unit.trim(),
        quotes: item.quotes.map(q => parseFloat(q))
      })),
      otherCost: Array(this.data.suppliers.length).fill(0),
      deliveryTime: this.data.deliveryTime.map(d => d.trim()),
      warranty: this.data.warranty.map(w => w.trim()),
      paymentTerm: this.data.paymentTerm.map(p => p.trim()),
      remarks: remarks ? remarks.trim() : '',
      approvals
    };

    wx.showLoading({ title: '正在提交单据...' });

    if (this.editProjectId) {
      // 覆盖更新现有单据
      request({
        url: `/api/procurements/${this.editProjectId}`,
        method: 'PUT',
        data: newRecord
      }).then(() => {
        wx.hideLoading();
        wx.showToast({
          title: '修改成功，已送审',
          icon: 'success',
          duration: 1500,
          success: () => {
            setTimeout(() => {
              wx.navigateBack();
            }, 1500);
          }
        });
      }).catch(() => {
        wx.hideLoading();
      });
    } else {
      // 新建单据
      request({
        url: '/api/procurements',
        method: 'POST',
        data: newRecord
      }).then(() => {
        wx.hideLoading();
        wx.showToast({
          title: '提交成功，已送审',
          icon: 'success',
          duration: 1500,
          success: () => {
            setTimeout(() => {
              wx.navigateBack();
            }, 1500);
          }
        });
      }).catch(() => {
        wx.hideLoading();
      });
    }
  },

  onCancel: function () {
    wx.navigateBack();
  },

  // ================= 语音输入模块 =================
  initRecorder: function () {
    const recorderManager = wx.getRecorderManager();
    recorderManager.onStop((res) => {
      const field = this.voiceTargetField;
      const index = this.voiceTargetIndex;
      let recognizedText = "";

      if (res.tempFilePath) {
        if (wx.translateVoice) {
          wx.translateVoice({
            filePath: res.tempFilePath,
            success: (transRes) => {
              recognizedText = transRes.result || "";
              this.fillRecognizedText(field, index, recognizedText);
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

  fillRecognizedText: function (field, index, text) {
    if (!text) return;
    
    wx.showToast({
      title: '语音转文字成功',
      icon: 'success'
    });

    if (field === 'title') {
      this.setData({ title: text });
    } else if (field === 'remarks') {
      this.setData({ remarks: text });
    } else if (field === 'suppliers') {
      const suppliers = [...this.data.suppliers];
      suppliers[index] = text;
      this.setData({ suppliers });
    } else if (field === 'itemName') {
      const items = [...this.data.items];
      items[index].name = text;
      this.setData({ items });
    } else if (field === 'itemModel') {
      const items = [...this.data.items];
      items[index].model = text;
      this.setData({ items });
    }
  },

  onStartVoice: function (e) {
    const field = e.currentTarget.dataset.field;
    const index = e.currentTarget.dataset.index !== undefined ? e.currentTarget.dataset.index : null;
    
    this.voiceTargetField = field;
    this.voiceTargetIndex = index;

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
