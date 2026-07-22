/**
 * 设备分组管理模块
 * 负责分组列表加载、渲染、增删改。
 * 分组内的播放同步（播放/暂停/停止/切歌/音量等）由后端 GroupCoordinator 实现，前端只管维护成员关系。
 */

const { apiGet, apiPost, apiDelete } = SongloftPlugin;
import { showSnackbar, escapeHtml } from './utils.js';
import { showDialog } from './modal.js';

/** 分组缓存 */
let groupsCache = [];
/** 设备（按账号分组）缓存，用于渲染成员名与成员选择 */
let deviceAccountsCache = [];

/**
 * 加载分组与设备并渲染
 */
export function loadGroups() {
    Promise.all([
        apiGet('/groups').catch(() => ({ success: false })),
        apiGet('/mina/devices').catch(() => ({ success: false })),
    ]).then(([groupsResp, devicesResp]) => {
        groupsCache = (groupsResp && groupsResp.success && Array.isArray(groupsResp.data)) ? groupsResp.data : [];
        deviceAccountsCache = (devicesResp && devicesResp.success && Array.isArray(devicesResp.data)) ? devicesResp.data : [];
        renderGroups();
    }).catch(error => {
        showSnackbar('加载分组失败：' + (error && error.message ? error.message : error), 'error');
    });
}

/** 由 account_id + device_id 反查设备显示名 */
function deviceDisplayName(accountId, deviceId) {
    for (const acc of deviceAccountsCache) {
        if (acc.account_id !== accountId || !acc.devices) continue;
        const found = acc.devices.find(d => d.deviceID === deviceId);
        if (found) return found.name || found.alias || deviceId;
    }
    return deviceId;
}

/**
 * 渲染分组列表
 */
function renderGroups() {
    const listEl = document.getElementById('groupList');
    if (!listEl) return;

    if (!groupsCache.length) {
        listEl.innerHTML = '<div class="empty-state small"><span class="material-symbols-outlined">speaker_group</span> 暂无分组</div>';
        return;
    }

    listEl.innerHTML = groupsCache.map(g => {
        const members = g.members || [];
        const memberNames = members.length
            ? members.map(m => escapeHtml(deviceDisplayName(m.account_id, m.device_id))).join('、')
            : '无成员';
        return `<div class="schedule-task-item">` +
            `<div class="schedule-task-main" onclick="window._openGroupEditor('${escapeHtml(g.id)}')">` +
            `<div class="schedule-task-icon"><span class="material-symbols-outlined">speaker_group</span></div>` +
            `<div class="schedule-task-info">` +
            `<div class="schedule-task-name">${escapeHtml(g.name)}</div>` +
            `<div class="schedule-task-desc">${members.length} 台：${memberNames}</div>` +
            `</div>` +
            `</div>` +
            `<div class="schedule-task-actions">` +
            `<button class="btn-icon btn-sm" onclick="window._openGroupEditor('${escapeHtml(g.id)}')" title="编辑">` +
            `<span class="material-symbols-outlined" style="font-size:18px">edit</span>` +
            `</button>` +
            `<button class="btn-icon btn-sm" onclick="window._deleteGroup('${escapeHtml(g.id)}')" title="删除">` +
            `<span class="material-symbols-outlined" style="font-size:18px">delete</span>` +
            `</button>` +
            `</div>` +
            `</div>`;
    }).join('');
}

/**
 * 渲染成员选择列表（仅已启用管理的设备，按账号分组）
 * @param {Array} selectedMembers - 已选中成员 [{account_id, device_id}]
 */
function renderGroupDeviceList(selectedMembers = []) {
    const container = document.getElementById('groupDeviceList');
    if (!container) return;

    const managedDevices = [];
    deviceAccountsCache.forEach(acc => {
        if (!acc.devices) return;
        acc.devices.forEach(dev => {
            if (!dev.managed) return;
            managedDevices.push({
                accountId: acc.account_id,
                accountName: acc.account_name,
                deviceId: dev.deviceID,
                deviceName: dev.name || dev.alias || '未命名',
                hardware: dev.hardware || dev.model || '',
            });
        });
    });

    if (managedDevices.length === 0) {
        container.innerHTML = '<div style="font-size:13px;color:var(--md-on-surface-variant);padding:8px 0">暂无可用设备，请先添加并启用设备管理</div>';
        return;
    }

    // 按账号分组
    const groups = {};
    managedDevices.forEach(dev => {
        if (!groups[dev.accountId]) {
            groups[dev.accountId] = { name: dev.accountName, devices: [] };
        }
        groups[dev.accountId].devices.push(dev);
    });

    const multiGroup = Object.keys(groups).length > 1;
    let html = '';
    for (const [accountId, group] of Object.entries(groups)) {
        if (multiGroup) {
            html += `<div class="schedule-device-group-title">${escapeHtml(group.name || accountId)}</div>`;
        }
        group.devices.forEach(dev => {
            const isChecked = selectedMembers.some(
                s => s.account_id === dev.accountId && s.device_id === dev.deviceId
            );
            html += `<label class="schedule-device-item">` +
                `<input type="checkbox" class="group-device-checkbox" ` +
                `data-account-id="${escapeHtml(dev.accountId)}" data-device-id="${escapeHtml(dev.deviceId)}" ` +
                `${isChecked ? 'checked' : ''}>` +
                `<span>${escapeHtml(dev.deviceName)}</span>` +
                (dev.hardware ? `<span class="schedule-device-hw">${escapeHtml(dev.hardware)}</span>` : '') +
                `</label>`;
        });
    }
    container.innerHTML = html;
}

/**
 * 打开分组编辑器（无 id 为新建，有 id 为编辑）
 * @param {string} [groupId]
 */
export async function openGroupEditor(groupId) {
    const editor = document.getElementById('groupEditor');
    const idField = document.getElementById('groupEditId');
    const nameField = document.getElementById('groupName');
    if (!editor || !idField || !nameField) return;

    let members = [];
    if (groupId) {
        const g = groupsCache.find(x => x.id === groupId);
        if (!g) {
            showSnackbar('分组不存在，请刷新后重试', 'error');
            return;
        }
        idField.value = g.id;
        nameField.value = g.name || '';
        members = g.members || [];
    } else {
        idField.value = '';
        nameField.value = '';
    }

    // 现拉一次设备列表，确保刚在账号区改动的「托管」勾选立即反映到成员选择，避免用旧缓存
    try {
        const resp = await apiGet('/mina/devices');
        if (resp && resp.success && Array.isArray(resp.data)) {
            deviceAccountsCache = resp.data;
        }
    } catch (e) {
        // 拉取失败则沿用已有缓存，不阻塞打开编辑器
    }

    renderGroupDeviceList(members);
    editor.style.display = '';
}

/**
 * 关闭分组编辑器
 */
export function closeGroupEditor() {
    const editor = document.getElementById('groupEditor');
    if (editor) editor.style.display = 'none';
}

/**
 * 收集编辑器中勾选的成员
 * @returns {Array} [{account_id, device_id}]
 */
function collectSelectedMembers() {
    const members = [];
    document.querySelectorAll('#groupDeviceList .group-device-checkbox').forEach(cb => {
        if (cb.checked) {
            members.push({
                account_id: cb.getAttribute('data-account-id'),
                device_id: cb.getAttribute('data-device-id'),
            });
        }
    });
    return members;
}

/**
 * 保存分组（新建或更新）
 */
export function saveGroup() {
    const idField = document.getElementById('groupEditId');
    const nameField = document.getElementById('groupName');
    if (!idField || !nameField) return;

    const id = idField.value;
    const name = nameField.value.trim();
    if (!name) {
        showSnackbar('请填写分组名称', 'warning');
        return;
    }

    const members = collectSelectedMembers();
    if (members.length < 2) {
        showSnackbar('分组至少需要选择 2 台设备', 'warning');
        return;
    }

    const req = id
        ? apiPost('/groups/update', { id, name, members })
        : apiPost('/groups', { name, members });

    req.then(data => {
        if (data && data.success) {
            showSnackbar(id ? '分组已更新' : '分组已创建', 'success');
            closeGroupEditor();
            loadGroups();
        } else {
            showSnackbar('保存失败：' + (data && data.error ? data.error : '未知错误'), 'error');
        }
    }).catch(error => {
        showSnackbar('保存失败：' + (error && error.message ? error.message : error), 'error');
    });
}

/**
 * 删除分组
 * @param {string} groupId
 */
export function deleteGroup(groupId) {
    const g = groupsCache.find(x => x.id === groupId);
    const name = g ? g.name : groupId;
    showDialog('删除分组', `确定删除分组「${name}」吗？删除后组内设备恢复为各自独立控制。`, '删除', '取消')
        .then(confirmed => {
            if (!confirmed) return;
            apiDelete('/groups?id=' + encodeURIComponent(groupId))
                .then(data => {
                    if (data && data.success) {
                        showSnackbar('分组已删除', 'success');
                        loadGroups();
                    } else {
                        showSnackbar('删除失败：' + (data && data.error ? data.error : '未知错误'), 'error');
                    }
                })
                .catch(error => {
                    showSnackbar('删除失败：' + (error && error.message ? error.message : error), 'error');
                });
        });
}
