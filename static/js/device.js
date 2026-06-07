/**
 * 设备管理模块
 * 负责设备列表加载、设备选择更新、设备状态管理
 */

const { apiGet, apiPost } = SongloftPlugin;
import { showSnackbar, showLoading, hideLoading, showResult, updateControlState, escapeHtml } from './utils.js';
import { closePlayModePanel, closeVolumePanel, initializePlaybackControls, syncVolumeFromDevice } from './playback.js';

/** 缓存所有账号的设备数据 */
let allAccountDevices = [];

/**
 * 获取缓存的所有账号设备数据
 * @returns {Array} 设备数据数组
 */
export function getAllAccountDevices() {
    return allAccountDevices;
}

/**
 * 根据选中的账号更新设备下拉框（仅显示 managed 设备）
 * @param {string} accountId - 账号 ID
 * @param {boolean} [autoSelect=true] - 是否自动选择上次的设备
 */
export function updateDeviceSelect(accountId, autoSelect = true) {
    const select = document.getElementById('deviceSelect');
    if (!select) return;

    select.innerHTML = '<option value="">请选择设备</option>';

    if (!accountId) {
        return;
    }

    const accountData = allAccountDevices.find(item => item.account_id === accountId);
    if (!accountData || !accountData.devices) {
        return;
    }

    accountData.devices.forEach(device => {
        if (!device.managed) return;

        const option = document.createElement('option');
        option.value = device.deviceID;
        const modelInfo = device.hardware || device.model || '未知型号';
        const statusText = device.presence === 'online' ? '[在线]' : '[离线]';
        option.textContent = (device.name || device.alias || '未命名') + ' [' + modelInfo + '] ' + statusText;
        select.appendChild(option);
    });

    // 自动选择最后一个选中的设备
    if (autoSelect) {
        const lastSelectedDeviceId = accountData.last_selected_device_id;
        if (lastSelectedDeviceId) {
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].value === lastSelectedDeviceId) {
                    select.selectedIndex = i;
                    break;
                }
            }
        }

        // 如果没有选中设备，选择第一个设备
        if (select.selectedIndex <= 0 && select.options.length > 1) {
            select.selectedIndex = 1;
        }
    }
}

/**
 * 加载所有设备列表（按账号维度）
 * @param {boolean} [isInitialLoad=false] - 是否为页面初始加载
 * @returns {Promise} 返回 Promise
 */
export function loadDevices(isInitialLoad = false) {
    return new Promise((resolve, reject) => {
        showLoading();
        apiGet('/mina/devices').then(data => {
            hideLoading();

            if (!data.success) {
                showResult(data);
                showSnackbar('加载设备失败：' + (data.error || '未知错误'), 'error');
                if (window.tracely) {
                    window.tracely.reportEvent('api_error', { path: '/mina/devices', error: data.error || '未知错误' });
                }
                reject(new Error(data.error || '未知错误'));
                return;
            }

            allAccountDevices = data.data || [];

            // 上报设备刷新事件
            if (window.tracely) {
                const totalDeviceCount = data.data.reduce((sum, account) => sum + (account.devices ? account.devices.length : 0), 0);
                window.tracely.reportEvent('device_refresh', { account_count: data.data.length, device_count: totalDeviceCount });
            }

            // 填充账号下拉框
            const accountSelect = document.getElementById('accountSelect');
            if (!accountSelect) {
                resolve(data);
                return;
            }

            const previousAccountId = accountSelect.value;
            accountSelect.innerHTML = '<option value="">请选择账号</option>';

            allAccountDevices.forEach(accountData => {
                const option = document.createElement('option');
                option.value = accountData.account_id;
                option.textContent = accountData.account_name;
                accountSelect.appendChild(option);
            });

            // 恢复之前选中的账号或选中第一个
            if (previousAccountId && allAccountDevices.some(a => a.account_id === previousAccountId)) {
                accountSelect.value = previousAccountId;
            } else if (allAccountDevices.length > 0) {
                accountSelect.value = allAccountDevices[0].account_id;
            }

            // 更新设备列表
            updateDeviceSelect(accountSelect.value, true);

            // 如果是初始加载且有上次选择的设备，自动确认选择
            if (isInitialLoad && allAccountDevices.length > 0) {
                const firstAccount = allAccountDevices[0];
                if (firstAccount.last_selected_device_id) {
                    // 自动恢复上次的设备选择（不弹出提示）
                    window.currentAccountId = firstAccount.account_id;
                    window.currentDeviceId = firstAccount.last_selected_device_id;
                    updateCurrentDeviceCard(firstAccount.account_id, firstAccount.last_selected_device_id);
                    updateControlState();
                }
            }

            // 设备列表刷新后，根据后端返回的最新 volume 同步音量 UI
            // 覆盖以下场景：1) 初始加载自动恢复设备 2) AppBar 刷新按钮 3) 已有选中设备时的列表刷新
            if (window.currentAccountId && window.currentDeviceId) {
                syncVolumeFromDevice();
            }

            showResult(data);
            resolve(data);
        }).catch(error => {
            hideLoading();
            showResult({ error: error.message });
            showSnackbar('加载设备失败：' + error.message, 'error');
            reject(error);
        });
    });
}

/**
 * 确认设备选择
 * 从 Tab 2 的选择框获取账号和设备，保存到全局变量
 */
export function confirmDeviceSelection() {
    const accountSelect = document.getElementById('accountSelect');
    const deviceSelect = document.getElementById('deviceSelect');

    const accountId = accountSelect ? accountSelect.value : '';
    const deviceId = deviceSelect ? deviceSelect.value : '';

    if (!accountId || !deviceId) {
        showSnackbar('请选择账号和设备', 'error');
        return;
    }

    // 保存到全局变量
    window.currentAccountId = accountId;
    window.currentDeviceId = deviceId;

    // 记录最后选择的设备到后端
    updateLastSelection(accountId, deviceId).catch(error => {
        console.error('记录最后选择设备失败:', error);
    });

    // 更新 Tab 1 中的当前设备卡片
    updateCurrentDeviceCard(accountId, deviceId);

    // 更新控制状态
    updateControlState();

    // 上报设备切换事件
    if (window.tracely) {
        const selectedOption = deviceSelect.options[deviceSelect.selectedIndex];
        window.tracely.reportEvent('device_switch', {
            account_id: accountId,
            device_id: deviceId,
            device_name: selectedOption ? selectedOption.textContent : '',
        });
    }

    showSnackbar('设备切换成功', 'success');

    // 切换到播放控制 Tab
    if (window.switchTab) {
        window.switchTab('player');
    }

    // 启动播放状态轮询
    import('./app.js').then(module => {
        if (module.startPlayerStatusPolling) {
            module.startPlayerStatusPolling();
        }
    });
}

/**
 * 更新 Tab 1 中的当前设备信息卡片
 * @param {string} accountId - 账号 ID
 * @param {string} deviceId - 设备 ID
 */
export function updateCurrentDeviceCard(accountId, deviceId) {
    const accountData = allAccountDevices.find(item => item.account_id === accountId);
    if (!accountData || !accountData.devices) return;

    const device = accountData.devices.find(d => d.deviceID === deviceId);
    if (!device) return;

    const deviceNameEl = document.getElementById('currentDeviceName');
    const deviceAccountEl = document.getElementById('currentDeviceAccount');
    const deviceStatusEl = document.getElementById('currentDeviceStatus');

    const modelName = device.hardware || device.model || '未知型号';
    const deviceName = (device.name || device.alias || '未命名') + ' [' + modelName + ']';

    if (deviceNameEl) {
        deviceNameEl.textContent = deviceName;
    }

    if (deviceAccountEl) {
        deviceAccountEl.textContent = accountData.account_name || accountId;
    }

    if (deviceStatusEl) {
        if (device.presence === 'online') {
            deviceStatusEl.textContent = '在线';
            deviceStatusEl.className = 'current-device-status online';
        } else {
            deviceStatusEl.textContent = '离线';
            deviceStatusEl.className = 'current-device-status offline';
        }
    }
}

/**
 * 获取指定设备的详细信息
 * @param {string} accountId - 账号 ID
 * @param {string} deviceId - 设备 ID
 * @returns {Object|null} 设备信息对象，如果未找到返回 null
 */
export function getDeviceInfo(accountId, deviceId) {
    const accountData = allAccountDevices.find(item => item.account_id === accountId);
    if (!accountData || !accountData.devices) return null;

    return accountData.devices.find(d => d.deviceID === deviceId) || null;
}

/**
 * 更新最后选择的设备
 * @param {string} accountId - 账号 ID
 * @param {string} deviceId - 设备 ID
 * @returns {Promise} 返回 Promise
 */
export function updateLastSelection(accountId, deviceId) {
    return new Promise((resolve, reject) => {
        apiPost('/mina/last_selection', {
            account_id: accountId,
            device_id: deviceId
        }).then(data => {
            if (data.success) {
                resolve(data);
            } else {
                // 静默失败，不影响用户体验
                console.warn('更新最后选择设备失败:', data.error);
                resolve(data);
            }
        }).catch(error => {
            // 静默失败，不影响用户体验
            console.error('更新最后选择设备异常:', error);
            reject(error);
        });
    });
}

// 兼容旧代码的别名
export const updateTopDeviceStatus = updateCurrentDeviceCard;

// ========== 设备选择弹出层 ==========

/**
 * 关闭所有弹出层的辅助函数
 */
function closeAllPopupsInternal() {
    closePlayModePanel();
    closeVolumePanel();
    closeDeviceSelectPanel();
}

/**
 * 打开/关闭设备选择面板
 * @param {HTMLElement} anchorEl - 锚点元素
 */
export function toggleDeviceSelectPanel(anchorEl) {
    const panel = document.getElementById('deviceSelectPanel');
    const backdrop = document.getElementById('deviceSelectBackdrop');

    if (!panel || !backdrop) return;

    if (panel.classList.contains('show')) {
        closeDeviceSelectPanel();
        return;
    }

    // 关闭其他弹出层
    closeAllPopupsInternal();

    // 渲染设备列表
    renderDeviceSelectList();

    // 定位 - 在 currentDeviceCard 下方
    const rect = anchorEl.getBoundingClientRect();
    const panelWidth = Math.min(320, window.innerWidth - 32);
    let left = rect.left;
    if (left + panelWidth > window.innerWidth - 16) {
        left = window.innerWidth - panelWidth - 16;
    }
    if (left < 16) left = 16;

    panel.style.left = left + 'px';
    panel.style.top = (rect.bottom + 8) + 'px';
    panel.style.bottom = 'auto';
    panel.style.width = panelWidth + 'px';

    backdrop.style.display = '';
    panel.classList.add('show');
}

/**
 * 关闭设备选择面板
 */
export function closeDeviceSelectPanel() {
    const panel = document.getElementById('deviceSelectPanel');
    const backdrop = document.getElementById('deviceSelectBackdrop');
    if (panel) panel.classList.remove('show');
    if (backdrop) backdrop.style.display = 'none';
}

/**
 * 渲染设备选择列表
 */
function renderDeviceSelectList() {
    const container = document.getElementById('deviceSelectList');
    if (!container) return;

    if (!allAccountDevices || allAccountDevices.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:24px;font-size:14px">暂无可用设备，请先添加账号</div>';
        return;
    }

    let html = '';
    const currentAccountId = window.currentAccountId;
    const currentDeviceId = window.currentDeviceId;

    allAccountDevices.forEach((accountData, index) => {
        // 检查是否有托管设备
        const managedDevices = accountData.devices ? accountData.devices.filter(d => d.managed) : [];
        if (managedDevices.length === 0) return;

        if (html !== '') {
            html += '<div class="device-select-divider"></div>';
        }
        html += `<div class="panel-header">${escapeHtml(accountData.account_name || accountData.account_id)}</div>`;

        managedDevices.forEach(device => {
            const isActive = accountData.account_id === currentAccountId && device.deviceID === currentDeviceId;
            const statusClass = device.presence === 'online' ? 'online' : 'offline';
            html += `
                <div class="device-select-item ${isActive ? 'active' : ''}"
                     onclick="selectDevice('${escapeHtml(accountData.account_id)}', '${escapeHtml(device.deviceID)}')">
                    <span class="material-symbols-outlined">speaker</span>
                    <div class="device-select-item-info">
                        <div class="device-select-item-name">${escapeHtml(device.name || device.alias || device.deviceID)}</div>
                        <div class="device-select-item-model">${escapeHtml(device.hardware || '')}</div>
                    </div>
                    <div class="device-select-item-trailing">
                        <span class="device-select-status ${statusClass}"></span>
                        <span class="material-symbols-outlined check-icon" style="${isActive ? '' : 'visibility:hidden'}">check</span>
                    </div>
                </div>
            `;
        });
    });

    if (html === '') {
        container.innerHTML = '<div class="empty-state" style="padding:24px;font-size:14px">暂无可用设备，请先添加账号</div>';
    } else {
        container.innerHTML = html;
    }
}

/**
 * 选择设备（从弹出层中选择）
 * @param {string} accountId - 账号 ID
 * @param {string} deviceId - 设备 ID
 */
export function selectDevice(accountId, deviceId) {
    closeDeviceSelectPanel();

    // 设置全局设备状态
    window.currentAccountId = accountId;
    window.currentDeviceId = deviceId;

    // 更新 Tab 1 设备卡片显示
    updateCurrentDeviceCard(accountId, deviceId);

    // 保存选择到后端
    updateLastSelection(accountId, deviceId).catch(error => {
        console.error('记录最后选择设备失败:', error);
    });

    // 更新控制状态
    updateControlState();

    // 初始化播放控制（音量、播放状态）
    initializePlaybackControls();

    // 上报设备切换事件
    if (window.tracely) {
        const accountData = allAccountDevices.find(a => a.account_id === accountId);
        const device = accountData && accountData.devices ? accountData.devices.find(d => d.deviceID === deviceId) : null;
        window.tracely.reportEvent('device_switch', {
            account_id: accountId,
            device_id: deviceId,
            device_name: device ? (device.name || device.alias || '') : '',
        });
    }

    showSnackbar('设备已切换', 'success');

    // 启动播放状态轮询
    import('./app.js').then(module => {
        if (module.startPlayerStatusPolling) {
            module.startPlayerStatusPolling();
        }
    });
}
