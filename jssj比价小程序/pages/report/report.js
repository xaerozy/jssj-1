const app = getApp();
const { request } = require('../../utils/request.js');

Page({
  data: {
    project: null,
    tempPagePaths: []
  },

  projectId: null,
  canvasWidth: 340, // 逻辑像素宽度固宽为 340px (对应 A4 比例)
  canvasHeight: 481, // 固高 481px (A4 标准 1:1.414 比例)

  onLoad: function (options) {
    this.projectId = options.id;
    wx.setNavigationBarTitle({
      title: `导出比价报告 ${app.globalData.version}`
    });
  },

  onShow: function () {
    wx.showLoading({ title: '正在拉取比价数据...' });
    request({ url: `/api/procurements/${this.projectId}` }).then(project => {
      // 过滤掉包含发起人名字的审批项
      const finalApprovals = project.approvals.filter(a => {
        const name = a.userName || a.role;
        return !project.creator.includes(name);
      });

      // 异步下载所有签字的网络图片为本地临时路径，以便 Canvas 能顺利绘制
      const downloadPromises = finalApprovals.map(a => {
        if (a.signature && a.signature.startsWith('http')) {
          return new Promise((resolve) => {
            wx.getImageInfo({
              src: a.signature,
              success: (res) => {
                a.signature = res.path; // 替换为本地临时路径
                resolve();
              },
              fail: (err) => {
                console.error('Download signature fail:', a.signature, err);
                resolve(); // 失败也继续，避免卡死
              }
            });
          });
        }
        return Promise.resolve();
      });

      Promise.all(downloadPromises).then(() => {
        wx.hideLoading();

        // 提取发起人的干净名字
        const cleanCreator = project.creator.replace(/^(采购员|经办人)-/, '');
        const virtualOperator = {
          role: '经办人',
          userName: cleanCreator,
          status: 'pending_paper', // 虚拟纸面手写状态
          time: '',
          comment: '',
          signature: ''
        };
        
        // 把“经办人”作为第一位强行加塞到签字区域
        const drawApprovals = [virtualOperator, ...finalApprovals];

        // 四大部门审批分类，用于四行两列签字大表格
        const opApprovals = [virtualOperator];
        const engApprovals = finalApprovals.filter(a => {
          const name = a.userName || '';
          const role = a.role || '';
          return role === '工程部' || role.includes('工程') || role.includes('部门经理') || role.includes('财务') || role.includes('出纳') || name.includes('李明') || name.includes('赵敏') || name.includes('小丽');
        });
        const prjApprovals = finalApprovals.filter(a => {
          const name = a.userName || '';
          const role = a.role || '';
          return role === '项目部' || role.includes('项目') || role.includes('总经理') || role.includes('副总经理') || role.includes('董事长') || name.includes('王总') || name.includes('周总');
        });
        const hqApprovals = finalApprovals.filter(a => {
          return !engApprovals.includes(a) && !prjApprovals.includes(a);
        });

        // 测量最长供应商名字实际字宽，用于条款两端拉伸对齐
        let maxSupWidth = 0;
        const supFontSize = 7.5; // ClauseItemFontSize
        project.suppliers.forEach(sup => {
          let w = 0;
          for (let i = 0; i < sup.length; i++) {
            const charCode = sup.charCodeAt(i);
            w += (charCode > 127 || charCode === 96) ? supFontSize : supFontSize * 0.52;
          }
          if (w > maxSupWidth) maxSupWidth = w;
        });

        // 1. 过滤和准备商务条款数据，用作列表绘制
        let delRows = [];
        let warRows = [];
        let payRows = [];

        project.suppliers.forEach((sup, idx) => {
          const dVal = project.deliveryTime && project.deliveryTime[idx];
          if (dVal && dVal.trim() !== '' && dVal.trim() !== '-') {
            delRows.push({ supplier: sup, value: dVal });
          }
          
          const wVal = project.warranty && project.warranty[idx];
          if (wVal && wVal.trim() !== '' && wVal.trim() !== '-') {
            warRows.push({ supplier: sup, value: wVal });
          }
          
          const pVal = project.paymentTerm && project.paymentTerm[idx];
          if (pVal && pVal.trim() !== '' && pVal.trim() !== '-') {
            payRows.push({ supplier: sup, value: pVal });
          }
        });

        // 2. 测量各物资行在各自列宽折行后的动态高度 (Dry Run 高度评估)
        // 表格左右各缩进12px，内容区宽度为 316px
        const tableLeft = 12;
        const contentWidth = 316;
        
        // 宽松的 hasModel 判断，全空/无/none/无型号/横线等都不作为型号列
        const hasModel = project.items.some(item => {
          if (!item.model) return false;
          const m = item.model.trim().toLowerCase();
          return m !== '' && m !== '-' && m !== '无' && m !== '/' && m !== 'none' && m !== '无型号';
        });
        
        // 固定列宽及动态计算
        const noColW = 18;
        const unitColW = 20;

        // 1. 动态估算数量列的单行宽度，确保数量单行显示
        let maxQtyLen = 2; // "数量" 两个字
        project.items.forEach(item => {
          const len = String(item.qty).length;
          if (len > maxQtyLen) maxQtyLen = len;
        });
        // 数量列文字使用常规字号 7.5px，字符宽度估算为 len * 7.5 * 0.55，加两边 padding 8px
        let qtyColW = Math.max(24, Math.ceil(maxQtyLen * 7.5 * 0.55 + 8));

        // 2. 动态估算供应商报价及合计总价的单行宽度，确保金额单行显示
        let maxPriceLen = 4; // 基础长度
        project.items.forEach(item => {
          item.quotes.forEach(quote => {
            const val = parseFloat(quote) || 0;
            const subTotal = val * item.qty;
            // 格式化金额，如 ¥1,250,000
            const priceText = `¥${subTotal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
            if (priceText.length > maxPriceLen) maxPriceLen = priceText.length;
          });
        });
        // 同时也需要考虑最下方合计行的总金额长度
        let totalCostsCalculated = Array(project.suppliers.length).fill(0);
        project.items.forEach(it => {
          it.quotes.forEach((q, sIdx) => {
            totalCostsCalculated[sIdx] += (parseFloat(q) || 0) * it.qty;
          });
        });
        totalCostsCalculated.forEach(cost => {
          const priceText = `¥${cost.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
          if (priceText.length > maxPriceLen) maxPriceLen = priceText.length;
        });
        // 金额文字字号最大为 7.8px，字符宽度估算为 len * 7.8 * 0.55，加两边 padding 10px
        let supplierColW = Math.max(40, Math.ceil(maxPriceLen * 7.8 * 0.55 + 10));

        const numSuppliers = project.suppliers.length;
        
        // 3. 计算分配给设备名称与型号的剩余可用宽度
        const totalAvail = contentWidth - (noColW + unitColW + qtyColW + numSuppliers * supplierColW);
        
        let nameColW = 0;
        let modelColW = 0;
        
        if (hasModel) {
          nameColW = Math.floor(totalAvail * (2.0 / 3.5));
          modelColW = totalAvail - nameColW;
          
          const minNameW = 45;
          const minModelW = 30;
          if (nameColW < minNameW) {
            nameColW = minNameW;
            modelColW = Math.max(0, totalAvail - nameColW);
          } else if (modelColW < minModelW) {
            modelColW = minModelW;
            nameColW = Math.max(0, totalAvail - modelColW);
          }
        } else {
          nameColW = totalAvail;
          modelColW = 0;
        }
        
        const baseColsWidth = noColW + nameColW + modelColW + unitColW + qtyColW;
        const colWidths = { noColW, nameColW, modelColW, unitColW, qtyColW, baseColsWidth, supplierColW };

        // 3. 布局参数配置 (普通和压缩)
        let layout = {
          isCompressed: false,
          headerStart: 60,
          tableHeaderH: 22,
          totalRowH: 22,
          clauseTitleH: 11,
          clauseItemMargin: 2,
          clauseItemLineH: 10.5,
          clauseBlockStart: 4,
          remarkBlockStart: 14,
          remarkLineH: 10.5,
          remarkBottomPadding: 6,
          signAreaH: 16,
          signRowH: 34,
          signBoxH: 30,
          minRowHeight: 26,
          rowLineH: 10.5,
          rowPadding: 4,
          
          headerFontSize: 7.5,
          headerLineHeight: 9,
          headerSupFontSize: 6.5,
          headerSupLineHeight: 7.5,
          
          itemFontSize: 7.5,
          itemNameLineHeight: 10.5,
          itemUnitQtyLineHeight: 9,
          itemQuoteFontSize: 7.2,
          itemQuoteLowestFontSize: 7.8,
          itemQuoteLineHeight: 9,
          
          totalFontSize: 7.5,
          totalLineHeight: 9,
          totalQuoteFontSize: 7.2,
          totalQuoteLowestFontSize: 7.8,
          totalQuoteLineHeight: 9,
          
          clauseSectionTitleFontSize: 8.5,
          clauseSubTitleFontSize: 7.8,
          clauseItemFontSize: 7.5,
          clauseItemLineHeight: 10.5,
          
          remarkTitleFontSize: 8,
          remarkTextFontSize: 7.5,
          remarkLineHeight: 10.5,
          
          signTitleFontSize: 8.5,
          signNameFontSize: 6.8,
          signDateFontSize: 5.2
        };

        let compressedLayout = {
          isCompressed: true,
          headerStart: 54,
          tableHeaderH: 19,
          totalRowH: 19,
          clauseTitleH: 8,
          clauseItemMargin: 1.5,
          clauseItemLineH: 9.5,
          clauseBlockStart: 3,
          remarkBlockStart: 10,
          remarkLineH: 9.5,
          remarkBottomPadding: 4,
          signAreaH: 10,
          signRowH: 28,
          signBoxH: 24,
          minRowHeight: 22,
          rowLineH: 9.5,
          rowPadding: 3,
          
          headerFontSize: 7.2,
          headerLineHeight: 8.5,
          headerSupFontSize: 6.2,
          headerSupLineHeight: 7.2,
          
          itemFontSize: 7.2,
          itemNameLineHeight: 9.5,
          itemUnitQtyLineHeight: 8,
          itemQuoteFontSize: 6.8,
          itemQuoteLowestFontSize: 7.5,
          itemQuoteLineHeight: 8,
          
          totalFontSize: 7.2,
          totalLineHeight: 8,
          totalQuoteFontSize: 6.8,
          totalQuoteLowestFontSize: 7.5,
          totalQuoteLineHeight: 8,
          
          clauseSectionTitleFontSize: 7.8,
          clauseSubTitleFontSize: 7.2,
          clauseItemFontSize: 7.0,
          clauseItemLineHeight: 9.5,
          
          remarkTitleFontSize: 7.5,
          remarkTextFontSize: 7.0,
          remarkLineHeight: 9.5,
          
          signTitleFontSize: 7.8,
          signNameFontSize: 6.2,
          signDateFontSize: 4.8
        };

        const remarksText = project.remarks || '';
        const clauseTextWidth = contentWidth - 12;

        const getBlockHeights = (lay) => {
          let itemsH = 0;
          project.items.forEach(item => {
            let nameLineCount = this.getTextLineCount(item.name, nameColW - 4, lay.itemFontSize);
            let modelText = item.model || '-';
            let modelLineCount = hasModel ? this.getTextLineCount(modelText, modelColW - 4, lay.itemFontSize) : 0;
            let maxLines = Math.max(nameLineCount, modelLineCount);
            let rHeight = Math.max(lay.minRowHeight, maxLines * lay.rowLineH + lay.rowPadding);
            itemsH += rHeight;
          });

          const labelBoxW = 18;
          const labelGap = 6;
          const valWidth = contentWidth - (labelBoxW + labelGap + 10 + maxSupWidth + 8);

          let delH = 0;
          if (delRows.length > 0) {
            delRows.forEach(row => {
              const lineCount = this.getTextLineCount(row.value, valWidth, lay.clauseItemFontSize);
              delH += lineCount * lay.clauseItemLineH + lay.clauseItemMargin;
            });
            delH = Math.max(delH, lay.isCompressed ? 20 : 24);
            delH += 4;
          }

          let warH = 0;
          if (warRows.length > 0) {
            warRows.forEach(row => {
              const lineCount = this.getTextLineCount(row.value, valWidth, lay.clauseItemFontSize);
              warH += lineCount * lay.clauseItemLineH + lay.clauseItemMargin;
            });
            warH = Math.max(warH, lay.isCompressed ? 26 : 32);
            warH += 4;
          }

          let payH = 0;
          if (payRows.length > 0) {
            payRows.forEach(row => {
              const lineCount = this.getTextLineCount(row.value, valWidth, lay.clauseItemFontSize);
              payH += lineCount * lay.clauseItemLineH + lay.clauseItemMargin;
            });
            payH = Math.max(payH, lay.isCompressed ? 26 : 32);
            payH += 4;
          }

          let remarkH = 0;
          if (remarksText && remarksText.trim() !== '') {
            remarkH += (lay.isCompressed ? 8 : 12) + lay.remarkBlockStart;
            const remarkLineCount = this.getTextLineCount(remarksText, contentWidth - 10, lay.remarkTextFontSize);
            remarkH += remarkLineCount * lay.remarkLineH + lay.remarkBottomPadding;
          }

          const rowsOfSign = 4;
          const signBoxH = rowsOfSign * lay.signRowH;
          const signH = lay.signAreaH + signBoxH;

          return { itemsH, delH, warH, payH, remarkH, signH };
        };

        // 评估普通布局的单页总高度
        const normalH = getBlockHeights(layout);
        let normalTotalH = layout.headerStart;
        normalTotalH += layout.tableHeaderH;
        normalTotalH += normalH.itemsH;
        normalTotalH += layout.totalRowH;
        let hasClauses = delRows.length > 0 || warRows.length > 0 || payRows.length > 0;
        if (hasClauses) {
          normalTotalH += layout.clauseTitleH + 14;
          normalTotalH += normalH.delH + normalH.warH + normalH.payH;
        }
        normalTotalH += normalH.remarkH;
        normalTotalH += normalH.signH;

        // 评估压缩布局的单页总高度
        const compH = getBlockHeights(compressedLayout);
        let compTotalH = compressedLayout.headerStart;
        compTotalH += compressedLayout.tableHeaderH;
        compTotalH += compH.itemsH;
        compTotalH += compressedLayout.totalRowH;
        if (hasClauses) {
          compTotalH += compressedLayout.clauseTitleH + 10;
          compTotalH += compH.delH + compH.warH + compH.payH;
        }
        compTotalH += compH.remarkH;
        compTotalH += compH.signH;

        // 决策最终布局：如果正常布局超出一页（481px），但压缩后可以塞进一页（<= 481px），则启用压缩布局
        let activeLayout = layout;
        if (normalTotalH > 481 && compTotalH <= 481) {
          activeLayout = compressedLayout;
        }

        // 将选定的布局应用到物资行高度
        project.items.forEach(item => {
          let nameLineCount = this.getTextLineCount(item.name, nameColW - 4, activeLayout.itemFontSize);
          let modelText = item.model || '-';
          let modelLineCount = hasModel ? this.getTextLineCount(modelText, modelColW - 4, activeLayout.itemFontSize) : 0;
          let maxLines = Math.max(nameLineCount, modelLineCount);
          let rHeight = Math.max(activeLayout.minRowHeight, maxLines * activeLayout.rowLineH + activeLayout.rowPadding);
          item.calculatedRowHeight = rHeight;
        });

        const finalH = getBlockHeights(activeLayout);
        const delBlockH = finalH.delH;
        const warBlockH = finalH.warH;
        const payBlockH = finalH.payH;
        const remarkBlockH = finalH.remarkH;
        const signAreaHeight = finalH.signH;

        // 保存布局配置及最长供应商字宽以便绘图使用
        colWidths.layout = activeLayout;
        colWidths.maxSupWidth = maxSupWidth;

        // 4. 物理分页算法规划（纯流式页切分，融入弹性容忍度）
        let pages = [];
        let curPage = {
          isFirst: true,
          items: [],
          drawHeader: false,
          drawTotal: false,
          delRows: [],
          warRows: [],
          payRows: [],
          remarks: '',
          drawSign: false,
          isLast: false,
          drawClauseTitle: false
        };
        
        let curY = activeLayout.headerStart;
        const maxPageY = 481 - 15; // 466px

        // 4.1 分配物资行
        project.items.forEach(item => {
          const rHeight = item.calculatedRowHeight || activeLayout.minRowHeight;
          const neededH = curPage.items.length === 0 ? (activeLayout.tableHeaderH + rHeight) : rHeight;
          
          if (curY + neededH > maxPageY) {
            pages.push(curPage);
            curPage = {
              isFirst: false,
              items: [item],
              drawHeader: true,
              drawTotal: false,
              delRows: [],
              warRows: [],
              payRows: [],
              remarks: '',
              drawSign: false,
              isLast: false,
              drawClauseTitle: false
            };
            curY = 15 + activeLayout.tableHeaderH + rHeight;
          } else {
            if (curPage.items.length === 0) {
              curPage.drawHeader = true;
            }
            curPage.items.push(item);
            curY += neededH;
          }
        });

        // 4.2 分配合计行
        if (curY + activeLayout.totalRowH > maxPageY) {
          pages.push(curPage);
          curPage = {
            isFirst: false,
            items: [],
            drawHeader: false,
            drawTotal: true,
            delRows: [],
            warRows: [],
            payRows: [],
            remarks: '',
            drawSign: false,
            isLast: false,
            drawClauseTitle: false
          };
          curY = 15 + activeLayout.totalRowH;
        } else {
          curPage.drawTotal = true;
          curY += activeLayout.totalRowH;
        }

        // 4.3 分配商务条款
        let hasDrawnClauseTitle = false;
        
        if (delRows.length > 0) {
          const titleH = hasDrawnClauseTitle ? 0 : (activeLayout.clauseTitleH + (activeLayout.isCompressed ? 10 : 14));
          const neededH = titleH + delBlockH;
          if (curY + neededH > maxPageY) {
            pages.push(curPage);
            curPage = {
              isFirst: false,
              items: [],
              drawHeader: false,
              drawTotal: false,
              delRows: delRows,
              warRows: [],
              payRows: [],
              remarks: '',
              drawSign: false,
              isLast: false,
              drawClauseTitle: true
            };
            hasDrawnClauseTitle = true;
            curY = 15 + activeLayout.clauseTitleH + delBlockH;
          } else {
            if (!hasDrawnClauseTitle) {
              curPage.drawClauseTitle = true;
              hasDrawnClauseTitle = true;
            }
            curPage.delRows = delRows;
            curY += neededH;
          }
        }

        if (warRows.length > 0) {
          const titleH = hasDrawnClauseTitle ? 0 : (activeLayout.clauseTitleH + (activeLayout.isCompressed ? 10 : 14));
          const neededH = titleH + warBlockH;
          if (curY + neededH > maxPageY) {
            pages.push(curPage);
            curPage = {
              isFirst: false,
              items: [],
              drawHeader: false,
              drawTotal: false,
              delRows: [],
              warRows: warRows,
              payRows: [],
              remarks: '',
              drawSign: false,
              isLast: false,
              drawClauseTitle: !hasDrawnClauseTitle
            };
            hasDrawnClauseTitle = true;
            curY = 15 + (curPage.drawClauseTitle ? activeLayout.clauseTitleH : 0) + warBlockH;
          } else {
            if (!hasDrawnClauseTitle) {
              curPage.drawClauseTitle = true;
              hasDrawnClauseTitle = true;
            }
            curPage.warRows = warRows;
            curY += neededH;
          }
        }

        if (payRows.length > 0) {
          const titleH = hasDrawnClauseTitle ? 0 : (activeLayout.clauseTitleH + (activeLayout.isCompressed ? 10 : 14));
          const neededH = titleH + payBlockH;
          if (curY + neededH > maxPageY) {
            pages.push(curPage);
            curPage = {
              isFirst: false,
              items: [],
              drawHeader: false,
              drawTotal: false,
              delRows: [],
              warRows: [],
              payRows: payRows,
              remarks: '',
              drawSign: false,
              isLast: false,
              drawClauseTitle: !hasDrawnClauseTitle
            };
            hasDrawnClauseTitle = true;
            curY = 15 + (curPage.drawClauseTitle ? activeLayout.clauseTitleH : 0) + payBlockH;
          } else {
            if (!hasDrawnClauseTitle) {
              curPage.drawClauseTitle = true;
              hasDrawnClauseTitle = true;
            }
            curPage.payRows = payRows;
            curY += neededH;
          }
        }

        // 4.4 分配推荐原因
        if (remarkBlockH > 0) {
          if (curY + remarkBlockH > maxPageY) {
            pages.push(curPage);
            curPage = {
              isFirst: false,
              items: [],
              drawHeader: false,
              drawTotal: false,
              delRows: [],
              warRows: [],
              payRows: [],
              remarks: remarksText,
              drawSign: false,
              isLast: false,
              drawClauseTitle: false
            };
            curY = 15 + remarkBlockH;
          } else {
            curPage.remarks = remarksText;
            curY += remarkBlockH;
          }
        }

        // 4.5 分配签字区 (赋予 15px 弹性超页容忍，尽量合并在第一页)
        if (curY + signAreaHeight > maxPageY + 15) {
          pages.push(curPage);
          curPage = {
            isFirst: false,
            items: [],
            drawHeader: false,
            drawTotal: false,
            delRows: [],
            warRows: [],
            payRows: [],
            remarks: '',
            drawSign: true,
            isLast: false,
            drawClauseTitle: false
          };
          curY = 15 + signAreaHeight;
        } else {
          curPage.drawSign = true;
          curY += signAreaHeight;
        }

        pages.push(curPage);
        pages[pages.length - 1].isLast = true;

        this.setData({ project });

        // 启动分页绘制导出
        this.setData({
          tempPagePaths: []
        });
        
        setTimeout(() => {
          this.drawAndExportPages(pages, delRows, warRows, payRows, colWidths, 0, []);
        }, 350);
      });
    }).catch(err => {
      wx.hideLoading();
      console.error('拉取比价数据失败:', err);
      wx.showToast({ title: '加载报告数据失败', icon: 'none' });
    });
  },

  // 多页递归导出
  drawAndExportPages: function (pages, delRows, warRows, payRows, colWidths, pageIdx, accumulatedPaths) {
    wx.showLoading({ title: `正在绘制第 ${pageIdx + 1}/${pages.length} 页...` });
    
    const ctx = wx.createCanvasContext('reportCanvas'); // 移除 this 传入以确保 Page 级寻址兼容性
    try {
      this.drawSinglePage(ctx, pages, pageIdx, delRows, warRows, payRows, colWidths);
    } catch (e) {
      wx.hideLoading();
      console.error("drawSinglePage error at page:", pageIdx, e);
      wx.showModal({
        title: '绘制报告发生异常',
        content: `第 ${pageIdx + 1} 页绘制出错：${e.message || '未知错误'}\n请检查数据是否完整或重试。`,
        showCancel: false
      });
      return;
    }
    
    ctx.draw(false, () => {
      wx.showLoading({ title: `正在导出第 ${pageIdx + 1}/${pages.length} 页...` });
      // 小延时保证渲染完毕后再进行 tempFilePath 导出
      setTimeout(() => {
        wx.canvasToTempFilePath({
          canvasId: 'reportCanvas',
          destWidth: 340 * 4, // 4倍分辨率导出，极度清晰
          destHeight: 481 * 4,
          fileType: 'jpg', // 修改为 jpg，体积小且可以直接打包为 PDF
          success: (res) => {
            accumulatedPaths.push(res.tempFilePath);
            if (pageIdx < pages.length - 1) {
              // 递归下一页，同样使用 colWidths 对象
              this.drawAndExportPages(pages, delRows, warRows, payRows, colWidths, pageIdx + 1, accumulatedPaths);
            } else {
              wx.hideLoading();
              this.setData({
                tempPagePaths: accumulatedPaths
              });
              wx.showToast({ title: '报告生成成功', icon: 'success' });
            }
          },
          fail: (err) => {
            wx.hideLoading();
            console.error("Canvas export failed at page:", pageIdx, err);
            wx.showToast({ title: '导出分页失败', icon: 'none' });
          }
        }, this);
      }, 150);
    });
  },

  // 绘制单页内容
  drawSinglePage: function (ctx, pages, pageIdx, delRows, warRows, payRows, colWidths) {
    const w = 340;
    const h = 481;
    const pageData = pages[pageIdx];

    // 解构自适应列宽对象和布局参数
    const { noColW, nameColW, modelColW, unitColW, qtyColW, baseColsWidth, supplierColW, layout, maxSupWidth } = colWidths;
    const lay = layout; // 简写

    // 1. 绘制白底
    ctx.setFillStyle('#ffffff');
    ctx.fillRect(0, 0, w, h);

    // 2. 绘制网格边框背景
    ctx.setStrokeStyle('#e5e7eb');
    ctx.setLineWidth(1);
    ctx.strokeRect(5, 5, w - 10, h - 10);

    let currentY = 15;

    // 3. 绘制第一页头部
    if (pageData.isFirst) {
      const isComp = lay.isCompressed;
      const titleY = isComp ? 24 : 28;
      const subY = isComp ? 36 : 42;
      const lineY = isComp ? 42 : 48;
      const infoY = isComp ? 50 : 57;

      ctx.setFontSize(14);
      ctx.font = 'normal bold 14px sans-serif';
      ctx.setFillStyle('#1a305c');
      ctx.setTextAlign('center');
      ctx.fillText('公司采购比价审核确认单', w / 2, titleY);

      // 绘制项目副标题 (长标题折行，不使用省略号)
      this.drawCenteredWrappedText(ctx, this.data.project.title, w / 2, subY, w - 60, isComp ? 9.5 : 11, isComp ? 8 : 8.5, '#4b5563');

      // 绘制分隔线
      ctx.setStrokeStyle('#1a305c');
      ctx.setLineWidth(1.5);
      ctx.beginPath();
      ctx.moveTo(12, lineY);
      ctx.lineTo(w - 12, lineY);
      ctx.stroke();

      // 发起信息
      ctx.setFontSize(isComp ? 7.0 : 7.5);
      ctx.font = `normal normal ${isComp ? 7.0 : 7.5}px sans-serif`;
      ctx.setFillStyle('#6b7280');
      ctx.setTextAlign('left');
      ctx.fillText(`申请人员: ${this.data.project.creator}`, 15, infoY);
      ctx.setTextAlign('right');
      ctx.fillText(`发起日期: ${this.data.project.createTime.split(' ')[0]}`, w - 15, infoY);

      currentY = lay.headerStart; // 表格起点
    }

    const tableLeft = 12;
    const contentWidth = w - 24;
    
    // 4. 绘制明细表格单层表头、数据行、合计行
    const hasTableContent = pageData.drawHeader || (pageData.items && pageData.items.length > 0) || pageData.drawTotal;
    
    if (hasTableContent) {
      // 4.1 绘制表头
      if (pageData.drawHeader) {
        ctx.setFillStyle('#f3f4f6');
        ctx.fillRect(tableLeft, currentY, contentWidth, lay.tableHeaderH);
        ctx.setStrokeStyle('#d1d5db');
        ctx.setLineWidth(0.8);
        ctx.strokeRect(tableLeft, currentY, contentWidth, lay.tableHeaderH);

        // 表头文字居中
        this.drawCellText(ctx, '序号', tableLeft, currentY, noColW, lay.tableHeaderH, 'center', lay.headerFontSize, lay.headerLineHeight, '#1a305c', true, true);
        this.drawCellText(ctx, '设备名称', tableLeft + noColW, currentY, nameColW, lay.tableHeaderH, 'center', lay.headerFontSize, lay.headerLineHeight, '#1a305c', true);
        if (modelColW > 0) {
          this.drawCellText(ctx, '型号', tableLeft + noColW + nameColW, currentY, modelColW, lay.tableHeaderH, 'center', lay.headerFontSize, lay.headerLineHeight, '#1a305c', true);
        }
        this.drawCellText(ctx, '单位', tableLeft + noColW + nameColW + modelColW, currentY, unitColW, lay.tableHeaderH, 'center', lay.headerFontSize, lay.headerLineHeight, '#1a305c', true, true);
        this.drawCellText(ctx, '数量', tableLeft + noColW + nameColW + modelColW + unitColW, currentY, qtyColW, lay.tableHeaderH, 'center', lay.headerFontSize, lay.headerLineHeight, '#1a305c', true, true);

        this.data.project.suppliers.forEach((sup, idx) => {
          const supLeft = tableLeft + baseColsWidth + idx * supplierColW;
          this.drawCellText(ctx, sup, supLeft, currentY, supplierColW, lay.tableHeaderH, 'center', lay.headerSupFontSize, lay.headerSupLineHeight, '#1a305c', true);
        });

        // 绘制表头纵向分割线
        let lineX = tableLeft + noColW;
        ctx.beginPath(); ctx.moveTo(lineX, currentY); ctx.lineTo(lineX, currentY + lay.tableHeaderH); ctx.stroke();
        lineX += nameColW;
        ctx.beginPath(); ctx.moveTo(lineX, currentY); ctx.lineTo(lineX, currentY + lay.tableHeaderH); ctx.stroke();
        if (modelColW > 0) {
          lineX += modelColW;
          ctx.beginPath(); ctx.moveTo(lineX, currentY); ctx.lineTo(lineX, currentY + lay.tableHeaderH); ctx.stroke();
        }
        lineX += unitColW;
        ctx.beginPath(); ctx.moveTo(lineX, currentY); ctx.lineTo(lineX, currentY + lay.tableHeaderH); ctx.stroke();
        lineX += qtyColW;
        ctx.beginPath(); ctx.moveTo(lineX, currentY); ctx.lineTo(lineX, currentY + lay.tableHeaderH); ctx.stroke();

        this.data.project.suppliers.forEach((sup, idx) => {
          const supLeft = tableLeft + baseColsWidth + idx * supplierColW;
          if (idx > 0) {
            ctx.beginPath(); ctx.moveTo(supLeft, currentY); ctx.lineTo(supLeft, currentY + lay.tableHeaderH); ctx.stroke();
          }
        });

        currentY += lay.tableHeaderH;
      }

      // 4.2 绘制数据行
      if (pageData.items && pageData.items.length > 0) {
        pageData.items.forEach((item, itemIdx) => {
          const rHeight = item.calculatedRowHeight || lay.minRowHeight;
          
          if (itemIdx % 2 === 1) {
            ctx.setFillStyle('#fafafa');
            ctx.fillRect(tableLeft, currentY, contentWidth, rHeight);
          }
          ctx.setStrokeStyle('#d1d5db');
          ctx.setLineWidth(0.8);
          ctx.strokeRect(tableLeft, currentY, contentWidth, rHeight);

          // 绘制数据行纵向分割线
          let lx = tableLeft + noColW;
          ctx.beginPath(); ctx.moveTo(lx, currentY); ctx.lineTo(lx, currentY + rHeight); ctx.stroke();
          lx += nameColW;
          ctx.beginPath(); ctx.moveTo(lx, currentY); ctx.lineTo(lx, currentY + rHeight); ctx.stroke();
          if (modelColW > 0) {
            lx += modelColW;
            ctx.beginPath(); ctx.moveTo(lx, currentY); ctx.lineTo(lx, currentY + rHeight); ctx.stroke();
          }
          lx += unitColW;
          ctx.beginPath(); ctx.moveTo(lx, currentY); ctx.lineTo(lx, currentY + rHeight); ctx.stroke();
          lx += qtyColW;
          ctx.beginPath(); ctx.moveTo(lx, currentY); ctx.lineTo(lx, currentY + rHeight); ctx.stroke();

          this.data.project.suppliers.forEach((sup, idx) => {
            const supLeft = tableLeft + baseColsWidth + idx * supplierColW;
            if (idx > 0) {
              ctx.beginPath(); ctx.moveTo(supLeft, currentY); ctx.lineTo(supLeft, currentY + rHeight); ctx.stroke();
            }
          });

          // 绘制数据行内容
          const realIndex = this.data.project.items.indexOf(item) + 1;
          this.drawCellText(ctx, `${realIndex}`, tableLeft, currentY, noColW, rHeight, 'center', lay.itemFontSize, lay.itemUnitQtyLineHeight, '#374151', false, true);
          this.drawCellText(ctx, item.name, tableLeft + noColW, currentY, nameColW, rHeight, 'left', lay.itemFontSize, lay.itemNameLineHeight, '#1f2937');
          if (modelColW > 0) {
            const modelText = item.model || '-';
            this.drawCellText(ctx, modelText, tableLeft + noColW + nameColW, currentY, modelColW, rHeight, 'left', lay.itemFontSize, lay.itemNameLineHeight, '#4b5563');
          }
          this.drawCellText(ctx, item.unit, tableLeft + noColW + nameColW + modelColW, currentY, unitColW, rHeight, 'center', lay.itemFontSize, lay.itemUnitQtyLineHeight, '#374151', false, true);
          this.drawCellText(ctx, `${item.qty}`, tableLeft + noColW + nameColW + modelColW + unitColW, currentY, qtyColW, rHeight, 'center', lay.itemFontSize, lay.itemUnitQtyLineHeight, '#374151', false, true);

          // 获取最低价高亮
          let lowestSubTotal = Infinity;
          item.quotes.forEach(q => {
            const val = parseFloat(q) || 0;
            const subTotal = val * item.qty;
            if (subTotal > 0 && subTotal < lowestSubTotal) lowestSubTotal = subTotal;
          });

          item.quotes.forEach((quote, supIdx) => {
            const supLeft = tableLeft + baseColsWidth + supIdx * supplierColW;
            const val = parseFloat(quote) || 0;
            const subTotal = val * item.qty;
            const priceText = `¥${subTotal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

            let color = '#374151';
            let isLowest = (subTotal === lowestSubTotal && lowestSubTotal !== Infinity);
            if (isLowest) color = '#059669'; // 最低价绿色
            
            this.drawCellText(ctx, priceText, supLeft, currentY, supplierColW, rHeight, 'center', isLowest ? lay.itemQuoteLowestFontSize : lay.itemQuoteFontSize, lay.itemQuoteLineHeight, color, isLowest, true);
          });

          currentY += rHeight;
        });
      }

      // 4.3 绘制合计行
      if (pageData.drawTotal) {
        ctx.setFillStyle('#eff6ff');
        ctx.fillRect(tableLeft, currentY, contentWidth, lay.totalRowH);
        ctx.setStrokeStyle('#d1d5db');
        ctx.setLineWidth(0.8);
        ctx.strokeRect(tableLeft, currentY, contentWidth, lay.totalRowH);

        // 绘制合计行纵向线 (前5列合并，仅画与供应商列的分割线)
        let lx = tableLeft + baseColsWidth;
        ctx.beginPath(); ctx.moveTo(lx, currentY); ctx.lineTo(lx, currentY + lay.totalRowH); ctx.stroke();

        this.data.project.suppliers.forEach((sup, idx) => {
          const supLeft = tableLeft + baseColsWidth + idx * supplierColW;
          if (idx > 0) {
            ctx.beginPath(); ctx.moveTo(supLeft, currentY); ctx.lineTo(supLeft, currentY + lay.totalRowH); ctx.stroke();
          }
        });

        // 绘制“合计(元)”
        this.drawCellText(ctx, '合计(元)', tableLeft, currentY, baseColsWidth, lay.totalRowH, 'center', lay.totalFontSize, lay.totalLineHeight, '#1a305c', true, true);

        // 计算总合计金额
        let totalCostsCalculated = Array(this.data.project.suppliers.length).fill(0);
        this.data.project.items.forEach(it => {
          it.quotes.forEach((q, sIdx) => {
            totalCostsCalculated[sIdx] += (parseFloat(q) || 0) * it.qty;
          });
        });

        let minC = Math.min(...totalCostsCalculated);
        totalCostsCalculated.forEach((cost, idx) => {
          const supLeft = tableLeft + baseColsWidth + idx * supplierColW;
          const priceText = `¥${cost.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
          let isMin = (cost === minC);
          let color = isMin ? '#059669' : '#374151';
          
          this.drawCellText(ctx, priceText, supLeft, currentY, supplierColW, lay.totalRowH, 'center', isMin ? lay.totalQuoteLowestFontSize : lay.totalQuoteFontSize, lay.totalQuoteLineHeight, color, isMin, true);
        });

        currentY += lay.totalRowH;
      }
    }

    // 5. 绘制商务条款 (平铺文字，两端对齐公司名，左侧垂直标签)
    const hasAnyClauseData = (pageData.delRows && pageData.delRows.length > 0) ||
                             (pageData.warRows && pageData.warRows.length > 0) ||
                             (pageData.payRows && pageData.payRows.length > 0);

    if (hasAnyClauseData) {
      currentY += lay.isCompressed ? 10 : 14;

      if (pageData.drawClauseTitle) {
        ctx.setFontSize(lay.clauseSectionTitleFontSize);
        ctx.setFillStyle('#1a305c');
        ctx.font = `normal bold ${lay.clauseSectionTitleFontSize}px sans-serif`;
        ctx.setTextAlign('left');
        ctx.fillText('📊 商务条款对比与结论', tableLeft, currentY + 2);
        currentY += lay.clauseTitleH + 2;
      }

      const labelBoxW = 18;
      const labelGap = 6;
      const valWidth = contentWidth - (labelBoxW + labelGap + 10 + maxSupWidth + 8);

      if (pageData.delRows && pageData.delRows.length > 0) {
        // 计算块高度
        let blockH = 0;
        pageData.delRows.forEach(row => {
          const lineCount = this.getTextLineCount(row.value, valWidth, lay.clauseItemFontSize);
          blockH += lineCount * lay.clauseItemLineH + lay.clauseItemMargin;
        });
        blockH = Math.max(blockH, lay.isCompressed ? 20 : 24);

        // 绘制垂直标签背景块
        ctx.setFillStyle('#eff6ff'); // 浅蓝色背景
        this.drawRoundedRect(ctx, tableLeft, currentY, labelBoxW, blockH, 3);
        ctx.fill();
        // 绘制标签垂直文本 "交货期"
        this.drawVerticalText(ctx, '交货期', tableLeft, currentY, labelBoxW, blockH, lay.clauseItemFontSize - 0.6, lay.clauseItemLineH, '#1e40af', true);

        let rowY = currentY;
        pageData.delRows.forEach(row => {
          // 1. 圆点
          ctx.setFontSize(lay.clauseItemFontSize);
          ctx.font = `normal normal ${lay.clauseItemFontSize}px sans-serif`;
          ctx.setFillStyle('#4b5563');
          ctx.setTextAlign('left');
          ctx.setTextBaseline('middle');
          ctx.fillText('●', tableLeft + labelBoxW + labelGap, rowY + lay.clauseItemLineH / 2);

          // 2. 两端对齐的公司名称
          const textX = tableLeft + labelBoxW + labelGap + 10;
          this.drawJustifiedText(ctx, row.supplier, textX, rowY + lay.clauseItemLineH / 2, maxSupWidth, lay.clauseItemFontSize, '#1a305c');

          // 3. 冒号
          const colonX = textX + maxSupWidth + 2;
          ctx.fillText('：', colonX, rowY + lay.clauseItemLineH / 2);

          // 4. 冒号后面的条款值内容 (自适应折行)
          const valX = colonX + 8;
          const lastY = this.drawWrappedText(ctx, row.value, valX, rowY, valWidth, lay.clauseItemLineH, lay.clauseItemFontSize, '#4b5563');
          
          rowY = lastY + lay.clauseItemLineH + lay.clauseItemMargin;
        });
        currentY = currentY + blockH + 4; // 更新 currentY
      }

      if (pageData.warRows && pageData.warRows.length > 0) {
        // 计算块高度
        let blockH = 0;
        pageData.warRows.forEach(row => {
          const lineCount = this.getTextLineCount(row.value, valWidth, lay.clauseItemFontSize);
          blockH += lineCount * lay.clauseItemLineH + lay.clauseItemMargin;
        });
        blockH = Math.max(blockH, lay.isCompressed ? 26 : 32);

        // 绘制垂直标签背景块
        ctx.setFillStyle('#f0fdf4'); // 浅绿色背景
        this.drawRoundedRect(ctx, tableLeft, currentY, labelBoxW, blockH, 3);
        ctx.fill();
        // 绘制标签垂直文本 "质保条件"
        this.drawVerticalText(ctx, '质保条件', tableLeft, currentY, labelBoxW, blockH, lay.clauseItemFontSize - 0.6, lay.clauseItemLineH - 1, '#166534', true);

        let rowY = currentY;
        pageData.warRows.forEach(row => {
          // 1. 圆点
          ctx.setFontSize(lay.clauseItemFontSize);
          ctx.font = `normal normal ${lay.clauseItemFontSize}px sans-serif`;
          ctx.setFillStyle('#4b5563');
          ctx.setTextAlign('left');
          ctx.setTextBaseline('middle');
          ctx.fillText('●', tableLeft + labelBoxW + labelGap, rowY + lay.clauseItemLineH / 2);

          // 2. 两端对齐的公司名称
          const textX = tableLeft + labelBoxW + labelGap + 10;
          this.drawJustifiedText(ctx, row.supplier, textX, rowY + lay.clauseItemLineH / 2, maxSupWidth, lay.clauseItemFontSize, '#1a305c');

          // 3. 冒号
          const colonX = textX + maxSupWidth + 2;
          ctx.fillText('：', colonX, rowY + lay.clauseItemLineH / 2);

          // 4. 冒号后面的条款值内容 (自适应折行)
          const valX = colonX + 8;
          const lastY = this.drawWrappedText(ctx, row.value, valX, rowY, valWidth, lay.clauseItemLineH, lay.clauseItemFontSize, '#4b5563');
          
          rowY = lastY + lay.clauseItemLineH + lay.clauseItemMargin;
        });
        currentY = currentY + blockH + 4; // 更新 currentY
      }

      if (pageData.payRows && pageData.payRows.length > 0) {
        // 计算块高度
        let blockH = 0;
        pageData.payRows.forEach(row => {
          const lineCount = this.getTextLineCount(row.value, valWidth, lay.clauseItemFontSize);
          blockH += lineCount * lay.clauseItemLineH + lay.clauseItemMargin;
        });
        blockH = Math.max(blockH, lay.isCompressed ? 26 : 32);

        // 绘制垂直标签背景块
        ctx.setFillStyle('#fff7ed'); // 浅橙色背景
        this.drawRoundedRect(ctx, tableLeft, currentY, labelBoxW, blockH, 3);
        ctx.fill();
        // 绘制标签垂直文本 "付款条款"
        this.drawVerticalText(ctx, '付款条款', tableLeft, currentY, labelBoxW, blockH, lay.clauseItemFontSize - 0.6, lay.clauseItemLineH - 1, '#c2410c', true);

        let rowY = currentY;
        pageData.payRows.forEach(row => {
          // 1. 圆点
          ctx.setFontSize(lay.clauseItemFontSize);
          ctx.font = `normal normal ${lay.clauseItemFontSize}px sans-serif`;
          ctx.setFillStyle('#4b5563');
          ctx.setTextAlign('left');
          ctx.setTextBaseline('middle');
          ctx.fillText('●', tableLeft + labelBoxW + labelGap, rowY + lay.clauseItemLineH / 2);

          // 2. 两端对齐的公司名称
          const textX = tableLeft + labelBoxW + labelGap + 10;
          this.drawJustifiedText(ctx, row.supplier, textX, rowY + lay.clauseItemLineH / 2, maxSupWidth, lay.clauseItemFontSize, '#1a305c');

          // 3. 冒号
          const colonX = textX + maxSupWidth + 2;
          ctx.fillText('：', colonX, rowY + lay.clauseItemLineH / 2);

          // 4. 冒号后面的条款值内容 (自适应折行)
          const valX = colonX + 8;
          const lastY = this.drawWrappedText(ctx, row.value, valX, rowY, valWidth, lay.clauseItemLineH, lay.clauseItemFontSize, '#4b5563');
          
          rowY = lastY + lay.clauseItemLineH + lay.clauseItemMargin;
        });
        currentY = currentY + blockH + 4; // 更新 currentY
      }
    }

    // 6. 绘制推荐原因说明
    if (pageData.remarks && pageData.remarks.trim() !== '') {
      currentY += lay.isCompressed ? 8 : 12;
      ctx.setFontSize(lay.remarkTitleFontSize);
      ctx.font = `normal bold ${lay.remarkTitleFontSize}px sans-serif`;
      ctx.setFillStyle('#1a305c');
      ctx.setTextAlign('left');
      ctx.fillText('💡 采购推荐原因说明：', tableLeft, currentY);
      currentY += lay.remarkBlockStart;
      
      const lastY = this.drawWrappedText(ctx, pageData.remarks, tableLeft + 10, currentY, w - 24 - 10, lay.remarkLineH, lay.remarkTextFontSize, '#4b5563');
      currentY = lastY + lay.remarkLineH + lay.remarkBottomPadding;
    }

    // 7. 绘制签字落款区 (四行两列大表格模型)
    if (pageData.drawSign) {
      const isComp = lay.isCompressed;
      // 确保签字区不与上方内容重叠，直接从 currentY + 10 开始绘制
      let signY = currentY + 10;
      
      ctx.setStrokeStyle('#e5e7eb');
      ctx.setLineWidth(1);
      ctx.beginPath();
      ctx.moveTo(12, signY - 8);
      ctx.lineTo(w - 12, signY - 8);
      ctx.stroke();

      ctx.setFontSize(lay.signTitleFontSize);
      ctx.font = `normal bold ${lay.signTitleFontSize}px sans-serif`;
      ctx.setFillStyle('#1a305c');
      ctx.setTextAlign('left');
      ctx.fillText('📜 审批流手写电子签字凭证', tableLeft, signY + 2);

      signY += lay.signAreaH;
      
      const cleanCreator = this.data.project.creator.replace(/^(采购员|经办人)-/, '');
      const virtualOperator = {
        role: '经办人',
        userName: cleanCreator,
        status: 'pending_paper', // 虚拟纸面手写状态
        time: '',
        comment: '',
        signature: ''
      };
      
      const finalApprovals = this.data.project.approvals.filter(a => {
        const name = a.userName || a.role;
        return !this.data.project.creator.includes(name);
      });

      // 四个大类的分配
      const opApprovals = [virtualOperator];
      const engApprovals = finalApprovals.filter(a => {
        const name = a.userName || '';
        const role = a.role || '';
        return role === '工程部' || role.includes('工程') || role.includes('部门经理') || role.includes('财务') || role.includes('出纳') || name.includes('李明') || name.includes('赵敏') || name.includes('小丽');
      });
      const prjApprovals = finalApprovals.filter(a => {
        const name = a.userName || '';
        const role = a.role || '';
        return role === '项目部' || role.includes('项目') || role.includes('总经理') || role.includes('副总经理') || role.includes('董事长') || name.includes('王总') || name.includes('周总');
      });
      const hqApprovals = finalApprovals.filter(a => {
        return !engApprovals.includes(a) && !prjApprovals.includes(a);
      });

      const depts = [
        { label: '经办人', list: opApprovals },
        { label: '工程部', list: engApprovals },
        { label: '项目部', list: prjApprovals },
        { label: '公司核准', list: hqApprovals }
      ];

      const deptColW = 56;
      const signColW = contentWidth - deptColW; // 260

      ctx.setStrokeStyle('#d1d5db');
      ctx.setLineWidth(0.8);

      depts.forEach((dept, idx) => {
        const rowTop = signY + idx * lay.signRowH;

        // 1. 绘制第一列（部门名称）
        ctx.setFillStyle('#f9fafb');
        ctx.fillRect(tableLeft, rowTop, deptColW, lay.signRowH);
        ctx.strokeRect(tableLeft, rowTop, deptColW, lay.signRowH);
        this.drawCellText(ctx, dept.label, tableLeft, rowTop, deptColW, lay.signRowH, 'center', lay.signNameFontSize, lay.signNameFontSize + 2, '#1a305c', true, true);

        // 2. 绘制第二列（签名和日期大格）
        ctx.strokeRect(tableLeft + deptColW, rowTop, signColW, lay.signRowH);

        const list = dept.list;
        if (list.length === 0) {
          // 如果没有该部门的人员审核，绘制 — 表示无需核准
          this.drawCellText(ctx, '—', tableLeft + deptColW, rowTop, signColW, lay.signRowH, 'center', lay.signNameFontSize, lay.signNameFontSize + 2, '#9ca3af', false, true);
        } else {
          // 在 260px 宽度中并排均分绘制多个人员签字
          const singleBoxW = signColW / list.length;
          list.forEach((appr, aIdx) => {
            const boxLeft = tableLeft + deptColW + aIdx * singleBoxW;

            // 绘制小格间的竖向分割线
            if (aIdx > 0) {
              ctx.beginPath();
              ctx.moveTo(boxLeft, rowTop);
              ctx.lineTo(boxLeft, rowTop + lay.signRowH);
              ctx.stroke();
            }

            // 计算姓名/日期区域宽度（约占小格的 45%）
            const leftW = Math.max(42, Math.min(60, singleBoxW * 0.45));
            const rightW = singleBoxW - leftW;
            const leftCenterX = boxLeft + leftW / 2;
            const rightCenterX = boxLeft + leftW + rightW / 2;

            // 绘制姓名（左侧上部）
            ctx.setFontSize(lay.signNameFontSize);
            ctx.font = `normal bold ${lay.signNameFontSize}px sans-serif`;
            ctx.setFillStyle('#1a305c');
            ctx.setTextAlign('center');
            ctx.setTextBaseline('middle');
            ctx.fillText(appr.userName || appr.role, leftCenterX, rowTop + lay.signRowH * 0.32);

            // 绘制日期（左侧下部）
            ctx.setFontSize(lay.signDateFontSize);
            ctx.font = `normal normal ${lay.signDateFontSize}px sans-serif`;
            ctx.setFillStyle('#6b7280');
            ctx.setTextAlign('center');
            ctx.setTextBaseline('middle');

            let dateText = appr.time ? appr.time.split(' ')[0] : '待确认';
            if (appr.status === 'pending_paper') {
              dateText = '  年  月  日';
            }
            ctx.fillText(dateText, leftCenterX, rowTop + lay.signRowH * 0.68);

            // 绘制签名部分（右侧区域）
            if (appr.status === 'pending_paper') {
              // 纸面手写签字引导线
              ctx.setStrokeStyle('rgba(156, 163, 175, 0.4)');
              ctx.setLineWidth(0.8);
              ctx.beginPath();
              ctx.moveTo(boxLeft + leftW + 4, rowTop + lay.signRowH / 2 + 4);
              ctx.lineTo(boxLeft + singleBoxW - 4, rowTop + lay.signRowH / 2 + 4);
              ctx.stroke();

              ctx.setFontSize(isComp ? 4.2 : 4.8);
              ctx.font = `normal normal ${isComp ? 4.2 : 4.8}px sans-serif`;
              ctx.setFillStyle('rgba(156, 163, 175, 0.6)');
              ctx.setTextAlign('center');
              ctx.setTextBaseline('middle');
              ctx.fillText('签字', rightCenterX, rowTop + lay.signRowH / 2 - 4);
            } else if (appr.status === 'approved') {
              if (appr.signature) {
                if (appr.signature === 'mock_sig_1' || appr.signature === 'mock_sig_2' || appr.signature === 'mock_sig_3' || appr.signature === 'mock_backup_stamp') {
                  ctx.beginPath();
                  ctx.arc(rightCenterX, rowTop + lay.signRowH / 2, isComp ? 6.0 : 7.0, 0, 2 * Math.PI);
                  ctx.setStrokeStyle('rgba(239, 68, 68, 0.4)');
                  ctx.setLineWidth(0.8);
                  ctx.stroke();

                  ctx.setFontSize(isComp ? 3.8 : 4.2);
                  ctx.font = `normal normal ${isComp ? 3.8 : 4.2}px sans-serif`;
                  ctx.setFillStyle('rgba(239, 68, 68, 0.7)');
                  ctx.setTextAlign('center');
                  ctx.setTextBaseline('middle');
                  ctx.fillText('已核准', rightCenterX, rowTop + lay.signRowH / 2);
                } else {
                  ctx.save();
                  ctx.translate(rightCenterX, rowTop + lay.signRowH / 2);
                  ctx.rotate(-Math.PI / 2);
                  const imgW = isComp ? 14 : 16;
                  const imgH = isComp ? 18 : 22;
                  ctx.drawImage(appr.signature, -imgW / 2, -imgH / 2, imgW, imgH);
                  ctx.restore();
                }
              } else {
                ctx.setFontSize(isComp ? 5.0 : 5.5);
                ctx.font = `normal normal ${isComp ? 5.0 : 5.5}px sans-serif`;
                ctx.setFillStyle('rgba(239, 68, 68, 0.7)');
                ctx.setTextAlign('center');
                ctx.setTextBaseline('middle');
                ctx.fillText('已授权确认', rightCenterX, rowTop + lay.signRowH / 2);
              }
            } else if (appr.status === 'rejected') {
              ctx.setFontSize(isComp ? 5.5 : 6.0);
              ctx.font = `normal normal ${isComp ? 5.5 : 6.0}px sans-serif`;
              ctx.setFillStyle('#ef4444');
              ctx.setTextAlign('center');
              ctx.setTextBaseline('middle');
              ctx.fillText('驳回修改', rightCenterX, rowTop + lay.signRowH / 2);
            } else {
              ctx.setFontSize(isComp ? 5.0 : 5.5);
              ctx.font = `normal normal ${isComp ? 5.0 : 5.5}px sans-serif`;
              ctx.setFillStyle('#9ca3af');
              ctx.setTextAlign('center');
              ctx.setTextBaseline('middle');
              ctx.fillText('（未确认）', rightCenterX, rowTop + lay.signRowH / 2);
            }
          });
        }
      });
    }

    // 9. 灰色水印
    ctx.setFontSize(6.5);
    ctx.font = 'normal normal 6.5px sans-serif';
    ctx.setFillStyle('rgba(156, 163, 175, 0.08)');
    ctx.setTextAlign('center');
    ctx.fillText('公司内部比价报告 · 仅供审计存证', w / 2, 100);
    ctx.fillText('公司内部比价报告 · 仅供审计存证', w / 2, Math.floor(h / 2));
    ctx.fillText('公司内部比价报告 · 仅供审计存证', w / 2, h - 110);

    // 10. 页码脚
    ctx.setFontSize(7);
    ctx.font = 'normal normal 7px sans-serif';
    ctx.setFillStyle('#9ca3af');
    ctx.setTextAlign('center');
    ctx.fillText(`— 第 ${pageIdx + 1} 页 / 共 ${pages.length} 页 —`, w / 2, h - 8);
  },

  // 分离出行的工具
  splitTextIntoLines: function (text, maxWidth, fontSize) {
    if (!text && text !== 0) return [];
    const textStr = String(text);
    let lines = [];
    let currentLine = '';
    let currentWidth = 0;
    for (let i = 0; i < textStr.length; i++) {
      const char = textStr[i];
      const charCode = textStr.charCodeAt(i);
      const isDoubleByte = charCode > 127 || charCode === 96;
      const charWidth = isDoubleByte ? fontSize : fontSize * 0.52;
      
      if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
      } else {
        currentLine += char;
        currentWidth += charWidth;
      }
    }
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
    return lines;
  },

  // 估算折行行数
  getTextLineCount: function (text, maxWidth, fontSize) {
    return this.splitTextIntoLines(text, maxWidth, fontSize).length;
  },

  // 高性能、支持对齐与居中的单元格绘制工具
  drawCellText: function (ctx, text, x, y, w, h, align, fontSize, lineHeight, color, isBold, noWrap) {
    if (!text && text !== 0) return;
    const textStr = String(text);
    
    ctx.setFontSize(fontSize);
    if (isBold) {
      ctx.font = `normal bold ${fontSize}px sans-serif`;
    } else {
      ctx.font = `normal normal ${fontSize}px sans-serif`;
    }
    ctx.setFillStyle(color || '#374151');
    ctx.setTextAlign(align);
    ctx.setTextBaseline('middle');

    const padding = 4;
    const maxWidth = Math.max(4, w - padding);
    
    const lines = noWrap ? [textStr] : this.splitTextIntoLines(textStr, maxWidth, fontSize);
    if (lines.length === 0) return;

    const totalH = lines.length * lineHeight;
    let startY = y + (h - totalH) / 2 + lineHeight / 2;

    for (let i = 0; i < lines.length; i++) {
      let drawX = x;
      if (align === 'center') {
        drawX = x + w / 2;
      } else if (align === 'right') {
        drawX = x + w - 2;
      } else {
        drawX = x + 2;
      }
      ctx.fillText(lines[i], drawX, startY);
      startY += lineHeight;
    }
  },
 
  // 纵向字排版辅助函数
  drawVerticalText: function (ctx, text, x, y, w, h, fontSize, lineHeight, color, isBold) {
    if (!text) return;
    ctx.setFontSize(fontSize);
    if (isBold) {
      ctx.font = `normal bold ${fontSize}px sans-serif`;
    } else {
      ctx.font = `normal normal ${fontSize}px sans-serif`;
    }
    ctx.setFillStyle(color || '#1a305c');
    ctx.setTextAlign('center');
    ctx.setTextBaseline('middle');

    const chars = text.split('');
    const totalH = chars.length * lineHeight;
    let startY = y + (h - totalH) / 2 + lineHeight / 2;
    const drawX = x + w / 2;

    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], drawX, startY);
      startY += lineHeight;
    }
  },

  // 两端对齐拉伸文本排版函数
  drawJustifiedText: function (ctx, text, x, y, targetWidth, fontSize, fillStyle) {
    if (!text) return;
    ctx.setFontSize(fontSize);
    ctx.font = `normal bold ${fontSize}px sans-serif`; // 公司名称加粗
    ctx.setFillStyle(fillStyle || '#1a305c');
    ctx.setTextAlign('left');
    ctx.setTextBaseline('middle');

    let actualWidth = 0;
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      actualWidth += (charCode > 127 || charCode === 96) ? fontSize : fontSize * 0.52;
    }

    const chars = text.split('');
    const L = chars.length;

    if (L <= 1 || targetWidth <= actualWidth) {
      ctx.fillText(text, x, y);
      return;
    }

    const charGap = (targetWidth - actualWidth) / (L - 1);
    let curX = x;

    for (let i = 0; i < L; i++) {
      ctx.fillText(chars[i], curX, y);
      const charCode = chars[i].charCodeAt(0);
      const charW = (charCode > 127 || charCode === 96) ? fontSize : fontSize * 0.52;
      curX += charW + charGap;
    }
  },

  // 居中换行
  drawCenteredWrappedText: function (ctx, text, x, y, maxWidth, lineHeight, fontSize, fillStyle) {
    ctx.setFontSize(fontSize);
    ctx.setFillStyle(fillStyle || '#4b5563');
    ctx.setTextAlign('center');
    
    let words = text.split('');
    let line = '';
    let currentY = y;
    
    for (let n = 0; n < words.length; n++) {
      let testLine = line + words[n];
      let testWidth = 0;
      
      for (let i = 0; i < testLine.length; i++) {
        const charCode = testLine.charCodeAt(i);
        const isDouble = charCode > 127 || charCode === 96;
        testWidth += isDouble ? fontSize : fontSize * 0.52;
      }

      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, currentY);
        line = words[n];
        currentY += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, currentY);
    return currentY;
  },

  // 左对齐换行
  drawWrappedText: function (ctx, text, x, y, maxWidth, lineHeight, fontSize, fillStyle) {
    ctx.setFontSize(fontSize);
    ctx.setFillStyle(fillStyle || '#4b5563');
    ctx.setTextAlign('left');
    ctx.setTextBaseline('middle');
    
    let words = text.split('');
    let line = '';
    let currentY = y;
    
    for (let n = 0; n < words.length; n++) {
      let testLine = line + words[n];
      let testWidth = 0;
      
      for (let i = 0; i < testLine.length; i++) {
        const charCode = testLine.charCodeAt(i);
        const isDouble = charCode > 127 || charCode === 96;
        testWidth += isDouble ? fontSize : fontSize * 0.52;
      }

      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, currentY + lineHeight / 2);
        line = words[n];
        currentY += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, currentY + lineHeight / 2);
    return currentY;
  },

  // 绘制圆角矩形辅助路径
  drawRoundedRect: function (ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  },

  // 保存全部图片到相册
  onSaveImage: function () {
    if (!this.data.tempPagePaths || this.data.tempPagePaths.length === 0) {
      wx.showToast({ title: '报告正在生成，请稍候', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在保存到相册...' });
    this.saveNextImage(0);
  },

  saveNextImage: function (idx) {
    const paths = this.data.tempPagePaths;
    wx.saveImageToPhotosAlbum({
      filePath: paths[idx],
      success: () => {
        if (idx < paths.length - 1) {
          this.saveNextImage(idx + 1);
        } else {
          wx.hideLoading();
          wx.showModal({
            title: '保存成功',
            content: `已成功将全部 ${paths.length} 页 A4 高清比价报告单图片保存到您的手机相册！您可以随时进行打印或转化为 PDF 存档。`,
            showCancel: false
          });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        if (err.errMsg.includes('auth')) {
          wx.showModal({
            title: '提示',
            content: '需要您的相册授权才能保存图片，请到设置页开启权限。',
            success: (setRes) => {
              if (setRes.confirm) wx.openSetting();
            }
          });
        } else {
          wx.showToast({ title: `第 ${idx + 1} 页保存失败`, icon: 'none' });
        }
      }
    });
  },

  // 分享发送 PDF (打包为多页 A4 满幅真实 PDF 并原生分享)
  onExportPDF: function () {
    if (!this.data.tempPagePaths || this.data.tempPagePaths.length === 0) {
      wx.showToast({ title: '报告正在生成，请稍候', icon: 'none' });
      return;
    }

    const paths = this.data.tempPagePaths;
    wx.showLoading({ title: '正在打包 PDF 文件...' });

    // 同步读取所有 JPEG 文件的二进制流并合成 PDF
    const fs = wx.getFileSystemManager();
    const imagesDataList = [];

    try {
      for (let i = 0; i < paths.length; i++) {
        const filePath = paths[i];
        const resData = fs.readFileSync(filePath); // 同步读取为 ArrayBuffer
        imagesDataList.push({
          data: resData,
          width: 340 * 4, // 对应 Canvas 导出的 destWidth
          height: 481 * 4 // 对应 Canvas 导出的 destHeight
        });
      }

      // 本地合成多页 PDF ArrayBuffer
      const pdfBuffer = this.convertJpegsToPdf(imagesDataList);

      // 过滤项目标题中的文件名非法字符
      const safeTitle = this.data.project.title.replace(/[\/\\:\*\?"<>\|]/g, '_');
      const pdfFilePath = `${wx.env.USER_DATA_PATH}/采购比价单_${safeTitle}.pdf`;

      // 写入到小程序本地临时存储
      fs.writeFileSync(pdfFilePath, pdfBuffer, 'binary');

      wx.hideLoading();

      // 原生唤起 PDF 预览，提供保存和发送
      wx.showModal({
        title: 'PDF 打包成功',
        content: `已成功将比价单打包为 A4 标准 PDF 文件（共 ${paths.length} 页）！现在您可以立即打开预览，并使用右上角菜单发送给朋友或保存。`,
        confirmText: '立即打开',
        success: (modalRes) => {
          if (modalRes.confirm) {
            wx.openDocument({
              filePath: pdfFilePath,
              fileType: 'pdf',
              showMenu: true, // 核心：显示右上角菜单，用于发送给朋友和保存
              success: () => {
                console.log('Open PDF document successfully.');
              },
              fail: (openErr) => {
                console.error('Open PDF document failed:', openErr);
                wx.showToast({ title: '打开 PDF 文件失败', icon: 'none' });
              }
            });
          }
        }
      });

    } catch (e) {
      wx.hideLoading();
      console.error('PDF packaging error:', e);
      wx.showToast({ title: '打包 PDF 失败，请稍后重试', icon: 'none' });
    }
  },

  // 简易文本转二进制字节流
  stringToUint8Array: function (str) {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      arr[i] = str.charCodeAt(i) & 0xFF;
    }
    return arr;
  },

  // 纯前端本地 JPEG 图像列表打包为多页 A4 满页 PDF 算法
  convertJpegsToPdf: function (imagesDataList) {
    let pdfParts = [];
    let currentOffset = 0;
    let objectOffsets = {};

    const write = (data) => {
      let buf;
      if (typeof data === 'string') {
        buf = this.stringToUint8Array(data);
      } else if (data instanceof ArrayBuffer) {
        buf = new Uint8Array(data);
      } else if (data instanceof Uint8Array) {
        buf = data;
      }
      pdfParts.push(buf);
      currentOffset += buf.length;
    };

    const startObj = (id) => {
      objectOffsets[id] = currentOffset;
      write(`${id} 0 obj\n`);
    };

    const endObj = () => {
      write("endobj\n");
    };

    // 1. PDF 头部
    write("%PDF-1.4\n");

    const numPages = imagesDataList.length;

    // 2. Catalog (对象ID = 1)
    startObj(1);
    write("<<\n  /Type /Catalog\n  /Pages 2 0 R\n>>\n");
    endObj();

    // 3. Pages 容器对象 (对象ID = 2)
    let kidsStr = "";
    for (let i = 0; i < numPages; i++) {
      const pageId = 3 + i * 3;
      kidsStr += `${pageId} 0 R `;
    }
    startObj(2);
    write(`<<\n  /Type /Pages\n  /Kids [ ${kidsStr} ]\n  /Count ${numPages}\n>>\n`);
    endObj();

    // 4. 为每一页依次写入 Page 描述对象、图像数据对象、以及渲染内容指令对象
    for (let i = 0; i < numPages; i++) {
      const pageId = 3 + i * 3;
      const imageId = 4 + i * 3;
      const contentId = 5 + i * 3;
      const imgData = imagesDataList[i];

      // Page 对象：定义纸张为标准 A4 (595x842pt) 并引用本页的图像和指令
      startObj(pageId);
      write(`<<\n  /Type /Page\n  /Parent 2 0 R\n  /MediaBox [0 0 595 842]\n  /Resources <<\n    /XObject << /Im1 ${imageId} 0 R >>\n  >>\n  /Contents ${contentId} 0 R\n>>\n`);
      endObj();

      // Image 对象：直接通过 /DCTDecode 无损嵌入 JPEG 原始字节流
      startObj(imageId);
      write(`<<\n  /Type /XObject\n  /Subtype /Image\n  /Width ${imgData.width}\n  /Height ${imgData.height}\n  /ColorSpace /DeviceRGB\n  /BitsPerComponent 8\n  /Filter /DCTDecode\n  /Length ${imgData.data.byteLength}\n>>\nstream\n`);
      write(imgData.data);
      write("\nendstream\n");
      endObj();

      // Contents 渲染指令：缩放平移矩阵 cm (595 0 0 842 0 0)，使得图片 100% 满幅填充 A4
      const contentStream = `q\n595 0 0 842 0 0 cm\n/Im1 Do\nQ\n`;
      startObj(contentId);
      write(`<<\n  /Length ${contentStream.length}\n>>\nstream\n${contentStream}endstream\n`);
      endObj();
    }

    // 5. 写入交叉引用表 xref
    const xrefStart = currentOffset;
    const totalObjects = 2 + numPages * 3;
    write("xref\n");
    write(`0 ${totalObjects + 1}\n`);
    write("0000000000 65535 f \n");
    for (let id = 1; id <= totalObjects; id++) {
      const offset = objectOffsets[id];
      const offsetStr = String(offset).padStart(10, '0');
      write(`${offsetStr} 00000 n \n`);
    }

    // 6. 写入 trailer 索引和 EOF 标识
    write(`trailer\n<<\n  /Size ${totalObjects + 1}\n  /Root 1 0 R\n>>\nstartxref\n${xrefStart}\n%%EOF\n`);

    // 7. 将分段数据合并为一个完整的 ArrayBuffer 字节数组
    let totalLength = 0;
    pdfParts.forEach(part => totalLength += part.length);

    const finalBuf = new Uint8Array(totalLength);
    let pos = 0;
    pdfParts.forEach(part => {
      finalBuf.set(part, pos);
      pos += part.length;
    });

    return finalBuf.buffer;
  },

  onBack: function () {
    wx.navigateBack();
  }
});
