/**
 * 账号管理模块
 * 负责账号列表加载、渲染、设备管理、账号增删
 */

const { apiGet, apiPost, apiDelete } = SongloftPlugin;
import { showSnackbar, escapeHtml } from './utils.js';
import { handleLoginResult } from './auth.js';
import { showDialog } from './modal.js';

/**
 * 重新登录账号
 * 先尝试快速重登（使用已保存凭证），失败再根据登录方式降级到对应的登录 Tab
 * @param {string} accountId - 账号 ID
 */
export function reLoginAccount(accountId) {
    showSnackbar('正在尝试快速重新登录...', 'info');

    apiPost('/auth/relogin', { account_id: accountId })
        .then(data => {
            if (data.success) {
                showSnackbar('重新登录成功', 'success');
                loadAccounts();
            } else {
                handleReLoginFallback(accountId, data.login_method);
            }
        })
        .catch(error => {
            showSnackbar('快速重登失败：' + error.message, 'warning');
            switchToAuthTab('qrcode', accountId);
        });
}

/**
 * 根据登录方式处理重新登录降级
 * @param {string} accountId - 账号 ID
 * @param {string} loginMethod - 登录方式
 */
function handleReLoginFallback(accountId, loginMethod) {
    switch (loginMethod) {
        case 'manual_token':
            showSnackbar('Token 已失效，请重新输入 Token', 'warning');
            switchToAuthTab('token');
            break;
        case 'password':
            showSnackbar('自动登录失败，密码可能已变更，请重新输入密码', 'warning');
            switchToAuthTab('password');
            break;
        case 'qrcode':
        default:
            showSnackbar('Token 已过期，请重新扫码登录', 'warning');
            switchToAuthTab('qrcode', accountId);
            break;
    }
}

/**
 * 切换到指定的登录子 Tab
 * @param {string} tabName - Tab 名称: 'qrcode' | 'password' | 'token'
 * @param {string} [accountId] - 账号 ID（扫码登录时传入）
 */
function switchToAuthTab(tabName, accountId) {
    // 切换到设备管理 Tab
    if (window.switchTab) {
        window.switchTab('devices');
    }

    // 切换子 Tab
    document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-tab-content').forEach(c => c.classList.remove('active'));

    const tabBtn = document.querySelector(`.auth-tab-btn[data-auth-tab="${tabName}"]`);
    const tabContent = document.getElementById('auth-tab-' + tabName);
    if (tabBtn) tabBtn.classList.add('active');
    if (tabContent) tabContent.classList.add('active');

    // 扫码登录自动触发获取二维码
    if (tabName === 'qrcode' && window._startQRCodeLogin) {
        window._startQRCodeLogin(accountId);
    }
}

/**
 * 加载账号列表并渲染
 */
export function loadAccounts() {
    const container = document.getElementById('accountList');
    if (!container) return;

    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span> 正在加载账号列表...</div>';

    apiGet('/auth/status').then(authData => {
        if (!authData.success || !authData.data || !Array.isArray(authData.data)) {
            container.innerHTML = '<div class="empty-state error"><span class="material-symbols-outlined">error</span> 获取账号列表失败</div>';
            return;
        }

        if (authData.data.length === 0) {
            container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">person_off</span> 暂无账号，请先添加</div>';
            return;
        }

        let html = '';
        authData.data.forEach(account => {
            html += renderAccountItem(account);
        });
        container.innerHTML = html;

        // 加载设备数据并渲染各账号的设备列表
        return loadAllDevices().then(devicesData => {
            if (devicesData.success && devicesData.data) {
                authData.data.forEach(account => {
                    loadAccountDevices(account.id, devicesData.data);
                });
            }
        });
    }).catch(error => {
        container.innerHTML = '<div class="empty-state error"><span class="material-symbols-outlined">error</span> 加载失败：' + escapeHtml(error.message) + '</div>';
        showSnackbar('加载账号列表失败：' + error.message, 'error');
    });
}

/**
 * 渲染单个账号项（MD3 风格）
 * @param {Object} account - 账号信息对象
 * @returns {string} HTML 字符串
 */
function renderAccountItem(account) {
    const isLoggedIn = account.logged_in;
    const isValid = account.is_valid;

    let statusClass = 'warning';
    let statusText = '未登录';
    let statusIcon = 'warning';

    if (isLoggedIn) {
        if (isValid) {
            statusClass = 'success';
            statusText = '已登录';
            statusIcon = 'check_circle';
        } else {
            statusClass = 'warning';
            statusText = 'Token 即将过期';
            statusIcon = 'schedule';
        }
    }

    const extraInfo = isLoggedIn
        ? `<div class="account-meta">用户 ID: ${escapeHtml(account.user_id || '未知')}</div>`
        : '';

    return `
        <div class="account-card">
            <div class="account-header">
                <div class="account-info">
                    <span class="account-name">${escapeHtml(account.account_name || account.name || account.id)}</span>
                    <span class="chip ${statusClass}">
                        <span class="material-symbols-outlined">${statusIcon}</span>
                        ${statusText}
                    </span>
                </div>
                <button class="btn-text" style="font-size:12px;padding:6px 10px" onclick="window._reLoginAccount('${escapeHtml(account.id)}')" title="重新登录"><span class="material-symbols-outlined" style="font-size:16px">refresh</span> 重新登录</button>
                <button class="btn-icon" onclick="window._deleteAccount('${escapeHtml(account.id)}')" title="删除账号">
                    <span class="material-symbols-outlined">delete</span>
                </button>
            </div>
            ${extraInfo}
            <div class="account-devices-section">
                <div class="account-devices-header">
                    <span class="material-symbols-outlined">speaker_group</span>
                    设备列表
                </div>
                <div class="account-devices" id="devices-${escapeHtml(account.id)}">
                    <div class="empty-state small"><span class="material-symbols-outlined">hourglass_empty</span> 加载中...</div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 加载所有设备数据
 * @returns {Promise} 设备数据 Promise
 */
function loadAllDevices() {
    return apiGet('/mina/devices');
}

/**
 * 加载并渲染指定账号的设备列表
 * @param {string} accountId - 账号 ID
 * @param {Array} devicesData - 设备数据数组
 */
function loadAccountDevices(accountId, devicesData) {
    const container = document.getElementById('devices-' + accountId);
    if (!container) return;

    if (!devicesData || !Array.isArray(devicesData)) {
        container.innerHTML = '<div class="empty-state small"><span class="material-symbols-outlined">speaker_group</span> 暂无设备</div>';
        return;
    }

    const accountData = devicesData.find(item => item.account_id === accountId);

    if (!accountData || !accountData.devices || accountData.devices.length === 0) {
        container.innerHTML = '<div class="empty-state small"><span class="material-symbols-outlined">speaker_group</span> 暂无设备</div>';
        return;
    }

    let html = '';
    accountData.devices.forEach(device => {
        html += renderDeviceItem(accountId, device);
    });
    container.innerHTML = html;
}

/**
 * 渲染单个设备项（MD3 风格）
 * @param {string} accountId - 账号 ID
 * @param {Object} device - 设备信息对象
 * @returns {string} HTML 字符串
 */
function renderDeviceItem(accountId, device) {
    const isChecked = device.managed ? 'checked' : '';
    const deviceName = escapeHtml(device.name || device.alias || '未命名设备');
    const deviceModel = escapeHtml(device.hardware || device.model || '未知型号');
    const statusClass = device.presence === 'online' ? 'online' : 'offline';
    const statusText = device.presence === 'online' ? '在线' : '离线';

    return `
        <label class="device-item">
            <input type="checkbox" class="device-checkbox" id="device-${escapeHtml(device.deviceID)}" ${isChecked}
                onchange="window._toggleDeviceManagement('${escapeHtml(accountId)}', '${escapeHtml(device.deviceID)}', this.checked)">
            <div class="device-item-content">
                <div class="device-item-name">${deviceName}</div>
                <div class="device-item-meta">
                    <span>${deviceModel}</span>
                    <span class="device-status ${statusClass}">${statusText}</span>
                </div>
            </div>
        </label>
    `;
}

/**
 * 切换设备管理状态
 * @param {string} accountId - 账号 ID
 * @param {string} deviceId - 设备 ID
 * @param {boolean} managed - 是否管理该设备
 */
export function toggleDeviceManagement(accountId, deviceId, managed) {
    apiPost('/mina/device/managed', { account_id: accountId, device_id: deviceId, managed: managed })
        .then(data => {
            if (!data.success) {
                showSnackbar('更新失败：' + (data.error || '未知错误'), 'error');
                const checkbox = document.getElementById('device-' + deviceId);
                if (checkbox) checkbox.checked = !managed;
            } else {
                showSnackbar(managed ? '已添加到管理列表' : '已从管理列表移除', 'success');
            }
        })
        .catch(error => {
            showSnackbar('更新失败：' + error.message, 'error');
            const checkbox = document.getElementById('device-' + deviceId);
            if (checkbox) checkbox.checked = !managed;
        });
}

/**
 * 添加账号（账号密码登录）
 */
export function addAccount() {
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username || !password) {
        showSnackbar('请填写用户名和密码', 'error');
        return;
    }

    apiPost('/auth/login', { username: username, password: password })
        .then(loginData => {
            if (loginData) {
                if (window.tracely) {
                    window.tracely.reportEvent('account_add', { method: 'password', success: !!loginData.success });
                }
                handleLoginResult(loginData);
            }
        })
        .catch(error => {
            showSnackbar('添加账号失败：' + error.message, 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/auth/login', error: error.message });
            }
        });
}

/**
 * 添加账号（手动设置 Token）
 */
export function addAccountWithToken() {
    const userIdInput = document.getElementById('tokenUserId');
    const passTokenInput = document.getElementById('passToken');

    const userId = userIdInput ? userIdInput.value.trim() : '';
    const passToken = passTokenInput ? passTokenInput.value.trim() : '';

    if (!userId || !passToken) {
        showSnackbar('请填写 User ID 和 Pass Token', 'error');
        return;
    }

    apiPost('/auth/token', { user_id: userId, pass_token: passToken })
        .then(tokenData => {
            if (tokenData && tokenData.success) {
                showSnackbar('账号添加成功', 'success');
                if (window.tracely) {
                    window.tracely.reportEvent('account_add', { method: 'token', success: true });
                }
                loadAccounts();
                if (userIdInput) userIdInput.value = '';
                if (passTokenInput) passTokenInput.value = '';
            } else if (tokenData) {
                showSnackbar('设置 Token 失败：' + tokenData.error, 'error');
                if (window.tracely) {
                    window.tracely.reportEvent('account_add', { method: 'token', success: false, error: tokenData.error });
                }
            }
        })
        .catch(error => {
            showSnackbar('添加账号失败：' + error.message, 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/auth/token', error: error.message });
            }
        });
}

/**
 * 删除账号
 * @param {string} accountId - 账号 ID
 */
export async function deleteAccount(accountId) {
    const confirmed = await showDialog('删除账号', `确定要删除账号 "${accountId}" 吗？此操作不可撤销。`, '删除', '取消');

    if (!confirmed) return;

    apiDelete('/account?account_id=' + encodeURIComponent(accountId))
        .then(data => {
            if (data.success) {
                showSnackbar('账号已删除', 'success');
                if (window.tracely) {
                    window.tracely.reportEvent('account_delete', { account_id: accountId });
                }
                loadAccounts();
            } else {
                showSnackbar('删除失败：' + data.error, 'error');
                if (window.tracely) {
                    window.tracely.reportEvent('api_error', { path: '/account', error: data.error });
                }
            }
        })
        .catch(error => {
            showSnackbar('删除失败：' + error.message, 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/account', error: error.message });
            }
        });
}
