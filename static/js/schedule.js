/**
 * 定时任务管理模块
 * 负责定时任务的 CRUD、开关控制、执行日志展示
 */

const { apiGet, apiPost, apiDelete } = SongloftPlugin;
import { showSnackbar } from './utils.js';
import { getAllAccountDevices } from './device.js';

/** 动作类型映射 */
const actionLabels = {
    'play_playlist': '播放歌单',
    'play_playlist_from': '播放歌单（指定位置）',
    'stop': '停止播放',
    'set_play_mode': '设置播放模式',
    'set_volume': '设置音量',
    'enable_monitor': '开启对话监听',
    'disable_monitor': '关闭对话监听',
};

const actionIcons = {
    'play_playlist': 'queue_music',
    'play_playlist_from': 'queue_music',
    'stop': 'stop',
    'set_play_mode': 'repeat',
    'set_volume': 'volume_up',
    'enable_monitor': 'hearing',
    'disable_monitor': 'hearing_disabled',
};

/** 播放模式映射 */
const playModeLabels = {
    'order': '顺序播放',
    'loop': '列表循环',
    'single': '单曲循环',
    'single-once': '单曲播放',
    'random': '随机播放',
};

/** 星期映射 */
const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 节假日模式映射 */
const holidayModeLabels = {
    'only_holiday': '仅节假日',
    'exclude_holiday': '真·工作日',
};

/** 当前定时任务列表缓存 */
let currentTasks = [];

/** 当前编辑的任务 ID（null 为新建） */
let editingTaskId = null;

// ========== 初始化 ==========

/**
 * 初始化定时任务 UI 事件
 */
export function initScheduleUI() {
    // 总开关事件
    const switchEl = document.getElementById('scheduledTasksSwitch');
    if (switchEl) {
        switchEl.addEventListener('change', function() {
            toggleScheduledTasks(this.checked);
        });
    }

    // 添加任务按钮
    const addBtn = document.getElementById('addScheduleBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => openScheduleForm(null));
    }

    // 查看日志按钮
    const logsBtn = document.getElementById('viewScheduleLogsBtn');
    if (logsBtn) {
        logsBtn.addEventListener('click', toggleScheduleLogs);
    }

    // 表单 overlay 事件
    const cancelBtn = document.getElementById('scheduleFormCancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeScheduleForm);
    }

    const saveBtn = document.getElementById('scheduleFormSaveBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveScheduleTask);
    }

    // 动作类型切换
    const actionSelect = document.getElementById('scheduleAction');
    if (actionSelect) {
        actionSelect.addEventListener('change', updateActionParams);
    }

    // 歌单选择联动：选择歌单后加载歌曲列表
    const playlistSelect = document.getElementById('schedulePlaylistSelect');
    if (playlistSelect) {
        playlistSelect.addEventListener('change', onPlaylistSelected);
    }

    // 调度类型切换
    const scheduleTypeSelect = document.getElementById('scheduleType');
    if (scheduleTypeSelect) {
        scheduleTypeSelect.addEventListener('change', updateScheduleTypeUI);
    }

    // 每日快捷按钮
    const dailyBtn = document.getElementById('scheduleDailyShortcut');
    if (dailyBtn) {
        dailyBtn.addEventListener('click', selectAllWeekdays);
    }

    // 工作日快捷按钮
    const workdayBtn = document.getElementById('scheduleWorkdayShortcut');
    if (workdayBtn) {
        workdayBtn.addEventListener('click', selectWorkdays);
    }

    // 目标设备"全选"联动
    const targetAllCb = document.getElementById('scheduleTargetAll');
    if (targetAllCb) {
        targetAllCb.addEventListener('change', updateDeviceListVisibility);
    }
}

// ========== 数据加载 ==========

/**
 * 加载定时任务列表
 */
export function loadSchedules() {
    apiGet('/schedules').then(data => {
        if (data.success && data.data) {
            const { enabled, tasks } = data.data;

            // 设置总开关
            const switchEl = document.getElementById('scheduledTasksSwitch');
            if (switchEl) switchEl.checked = !!enabled;
            updateScheduleStatus(enabled);

            currentTasks = tasks || [];
            renderScheduleList(currentTasks);
        }
    }).catch(err => console.error('加载定时任务失败:', err));
}

// ========== 开关控制 ==========

/**
 * 切换定时任务总开关
 */
function toggleScheduledTasks(enabled) {
    apiPost('/config', { scheduled_tasks_enabled: enabled })
        .then(data => {
            if (data.success) {
                showSnackbar(enabled ? '定时任务已开启' : '定时任务已关闭', 'success');
                updateScheduleStatus(enabled);
            } else {
                showSnackbar('操作失败：' + (data.error || '未知错误'), 'error');
                const switchEl = document.getElementById('scheduledTasksSwitch');
                if (switchEl) switchEl.checked = !enabled;
            }
        })
        .catch(error => {
            showSnackbar('操作失败：' + error.message, 'error');
            const switchEl = document.getElementById('scheduledTasksSwitch');
            if (switchEl) switchEl.checked = !enabled;
        });
}

function updateScheduleStatus(enabled) {
    const statusText = document.getElementById('scheduledTasksStatusText');
    if (statusText) {
        statusText.textContent = enabled ? '运行中' : '已关闭';
    }
}

// ========== 任务列表渲染 ==========

function renderScheduleList(tasks) {
    const listEl = document.getElementById('scheduleTaskList');
    if (!listEl) return;

    if (!tasks || tasks.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">暂无定时任务，点击上方按钮添加</div>';
        return;
    }

    listEl.innerHTML = tasks.map(task => {
        const icon = actionIcons[task.action] || 'schedule';
        const actionLabel = actionLabels[task.action] || task.action;
        const scheduleDesc = formatScheduleDesc(task.schedule);
        const paramDesc = formatParamDesc(task.action, task.params);
        const targetDesc = formatTargetDesc(task.target);

        return `<div class="schedule-task-item ${task.enabled ? '' : 'schedule-task-disabled'}">` +
            `<div class="schedule-task-main" onclick="window._editScheduleTask('${task.id}')">` +
            `<div class="schedule-task-icon"><span class="material-symbols-outlined">${icon}</span></div>` +
            `<div class="schedule-task-info">` +
            `<div class="schedule-task-name">${escapeHtml(task.name)}</div>` +
            `<div class="schedule-task-desc">${scheduleDesc} &middot; ${actionLabel}</div>` +
            (isGlobalAction(task.action) ? '' : (paramDesc ? `<div class="schedule-task-desc">${paramDesc} &middot; ${targetDesc}</div>` : `<div class="schedule-task-desc">${targetDesc}</div>`)) +
            `</div>` +
            `</div>` +
            `<div class="schedule-task-actions">` +
            `<label class="switch switch-sm">` +
            `<input type="checkbox" ${task.enabled ? 'checked' : ''} onchange="window._toggleScheduleTask('${task.id}', this.checked)">` +
            `<span class="switch-slider"></span>` +
            `</label>` +
            `<button class="btn-icon btn-sm" onclick="window._deleteScheduleTask('${task.id}')" title="删除">` +
            `<span class="material-symbols-outlined" style="font-size:18px">delete</span>` +
            `</button>` +
            `</div>` +
            `</div>`;
    }).join('');
}

function formatScheduleDesc(schedule) {
    if (!schedule) return '';
    let dayStr = '';
    if (schedule.type === 'weekly') {
        if (schedule.weekdays && schedule.weekdays.length === 7) {
            dayStr = '每天';
        } else if (schedule.weekdays) {
            dayStr = schedule.weekdays.map(d => weekdayLabels[d] || d).join('、');
        }
    } else if (schedule.type === 'monthly') {
        if (schedule.monthdays) {
            dayStr = '每月' + schedule.monthdays.map(d => d + '号').join('、');
        }
    }
    let base = dayStr + ' ' + (schedule.time || '');
    if (schedule.type === 'weekly' && schedule.holiday_mode && holidayModeLabels[schedule.holiday_mode]) {
        base += ' · ' + holidayModeLabels[schedule.holiday_mode];
    }
    return base;
}

function formatParamDesc(action, params) {
    if (!params) return '';
    switch (action) {
        case 'play_playlist':
            return params.playlist_name ? `歌单「${params.playlist_name}」` : '';
        case 'play_playlist_from': {
            const plName = params.playlist_name ? `歌单「${params.playlist_name}」` : '';
            const songDesc = params.song_name ? `从「${params.song_name}」开始` : '从第一首开始';
            return plName ? `${plName}（${songDesc}）` : '';
        }
        case 'set_play_mode':
            return playModeLabels[params.play_mode] || params.play_mode || '';
        case 'set_volume':
            return params.volume !== undefined ? `音量 ${params.volume}%` : '';
        default:
            return '';
    }
}

function formatTargetDesc(target) {
    if (target.all_managed) return '所有设备';
    if (!target.devices || target.devices.length === 0) return '未指定设备';
    if (target.devices.length === 1) {
        const dev = target.devices[0];
        const allAccounts = getAllAccountDevices();
        for (const acc of allAccounts) {
            if (acc.account_id !== dev.account_id || !acc.devices) continue;
            const found = acc.devices.find(d => d.deviceID === dev.device_id);
            if (found) return found.name || found.alias || dev.device_id;
        }
        return dev.device_id;
    }
    return target.devices.length + '台设备';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== 任务表单 ==========

/** 缓存歌单列表 */
let cachedPlaylists = [];

/**
 * 加载歌单列表到下拉框
 */
function loadPlaylistOptions() {
    return apiGet('/playlists').then(data => {
        const select = document.getElementById('schedulePlaylistSelect');
        if (!select) return;
        if (data.success && data.data) {
            cachedPlaylists = data.data;
            select.innerHTML = '<option value="">-- 请选择歌单 --</option>';
            data.data.forEach(pl => {
                const opt = document.createElement('option');
                opt.value = pl.id;
                opt.textContent = pl.name + ' (' + (pl.song_count || 0) + '首)';
                select.appendChild(opt);
            });
        }
    }).catch(err => {
        console.error('加载歌单列表失败:', err);
    });
}

/**
 * 歌单选择变更时加载歌曲列表
 */
function onPlaylistSelected() {
    const playlistId = document.getElementById('schedulePlaylistSelect').value;
    const songSelect = document.getElementById('scheduleSongSelect');
    if (!songSelect) return;

    songSelect.innerHTML = '<option value="">-- 从第一首开始 --</option>';
    if (!playlistId) return;

    apiGet('/playlists/' + playlistId + '/songs').then(data => {
        if (data.success && data.data) {
            data.data.forEach((song, index) => {
                const opt = document.createElement('option');
                opt.value = index;
                opt.textContent = (index + 1) + '. ' + (song.title || '未知') + (song.artist ? ' - ' + song.artist : '');
                songSelect.appendChild(opt);
            });
        }
    }).catch(err => console.error('加载歌曲列表失败:', err));
}

function openScheduleForm(taskId) {
    editingTaskId = taskId;
    const overlay = document.getElementById('scheduleFormOverlay');
    if (!overlay) return;

    const title = document.getElementById('scheduleFormTitle');
    if (title) title.textContent = taskId ? '编辑定时任务' : '添加定时任务';

    // 先加载歌单列表，再填充表单
    loadPlaylistOptions().then(() => {
        if (taskId) {
            const task = currentTasks.find(t => t.id === taskId);
            if (!task) return;
            fillForm(task);
        } else {
            resetForm();
        }
        updateActionParams();
        updateScheduleTypeUI();
        updateDeviceListVisibility();
    });

    overlay.classList.add('active');
}

function closeScheduleForm() {
    const overlay = document.getElementById('scheduleFormOverlay');
    if (overlay) overlay.classList.remove('active');
    editingTaskId = null;
}

function resetForm() {
    document.getElementById('scheduleName').value = '';
    document.getElementById('scheduleAction').value = 'play_playlist';
    document.getElementById('scheduleType').value = 'weekly';
    document.getElementById('scheduleTime').value = '08:00';
    document.getElementById('scheduleTargetAll').checked = false;
    renderScheduleDeviceList([]);

    // 清空星期选择
    document.querySelectorAll('.weekday-checkbox').forEach(cb => cb.checked = false);
    // 清空月日选择
    document.querySelectorAll('.monthday-checkbox').forEach(cb => cb.checked = false);

    // 节假日模式默认 ignore
    const hmEl = document.getElementById('scheduleHolidayMode');
    if (hmEl) hmEl.value = 'ignore';

    // 清空参数
    const playlistSelect = document.getElementById('schedulePlaylistSelect');
    if (playlistSelect) playlistSelect.value = '';
    const songSelect = document.getElementById('scheduleSongSelect');
    if (songSelect) songSelect.innerHTML = '<option value="">-- 从第一首开始 --</option>';
    const playMode = document.getElementById('schedulePlayMode');
    if (playMode) playMode.value = 'loop';
    const volume = document.getElementById('scheduleVolume');
    if (volume) volume.value = '50';
    const volumeLabel = document.getElementById('scheduleVolumeLabel');
    if (volumeLabel) volumeLabel.textContent = '50%';
}

function fillForm(task) {
    document.getElementById('scheduleName').value = task.name || '';
    document.getElementById('scheduleAction').value = task.action || 'play_playlist';
    document.getElementById('scheduleType').value = task.schedule.type || 'weekly';
    document.getElementById('scheduleTime').value = task.schedule.time || '08:00';
    document.getElementById('scheduleTargetAll').checked = !!task.target.all_managed;
    // 回填设备选择
    renderScheduleDeviceList(task.target.devices || []);
    updateDeviceListVisibility();

    // 星期选择
    document.querySelectorAll('.weekday-checkbox').forEach(cb => {
        const day = parseInt(cb.value);
        cb.checked = task.schedule.weekdays && task.schedule.weekdays.includes(day);
    });

    // 月日选择
    document.querySelectorAll('.monthday-checkbox').forEach(cb => {
        const day = parseInt(cb.value);
        cb.checked = task.schedule.monthdays && task.schedule.monthdays.includes(day);
    });

    // 节假日模式回填
    const hmEl = document.getElementById('scheduleHolidayMode');
    if (hmEl) hmEl.value = task.schedule.holiday_mode || 'ignore';

    // 歌单选择（按名称匹配）
    const playlistSelect = document.getElementById('schedulePlaylistSelect');
    if (playlistSelect && task.params.playlist_name) {
        // 在缓存中找到匹配的歌单并选中
        const pl = cachedPlaylists.find(p => p.name === task.params.playlist_name);
        if (pl) {
            playlistSelect.value = pl.id;
            // 联动加载歌曲列表
            if (task.action === 'play_playlist_from') {
                loadSongOptions(pl.id).then(() => {
                    // 按歌曲名称匹配选中
                    if (task.params.song_name) {
                        const songSelect = document.getElementById('scheduleSongSelect');
                        if (songSelect) {
                            for (let i = 0; i < songSelect.options.length; i++) {
                                if (songSelect.options[i].textContent.includes(task.params.song_name)) {
                                    songSelect.selectedIndex = i;
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        }
    }

    // 其他参数
    const playMode = document.getElementById('schedulePlayMode');
    if (playMode) playMode.value = task.params.play_mode || 'loop';
    const volume = document.getElementById('scheduleVolume');
    if (volume) volume.value = task.params.volume || 50;
    const volumeLabel = document.getElementById('scheduleVolumeLabel');
    if (volumeLabel) volumeLabel.textContent = (task.params.volume || 50) + '%';
}

/**
 * 加载指定歌单的歌曲到下拉框
 */
function loadSongOptions(playlistId) {
    const songSelect = document.getElementById('scheduleSongSelect');
    if (!songSelect) return Promise.resolve();
    songSelect.innerHTML = '<option value="">-- 从第一首开始 --</option>';
    if (!playlistId) return Promise.resolve();

    return apiGet('/playlists/' + playlistId + '/songs').then(data => {
        if (data.success && data.data) {
            data.data.forEach((song, index) => {
                const opt = document.createElement('option');
                opt.value = index;
                opt.textContent = (index + 1) + '. ' + (song.title || '未知') + (song.artist ? ' - ' + song.artist : '');
                songSelect.appendChild(opt);
            });
        }
    }).catch(err => console.error('加载歌曲列表失败:', err));
}

/** 全局动作（不绑定设备） */
const globalActions = ['enable_monitor', 'disable_monitor'];

function isGlobalAction(action) {
    return globalActions.includes(action);
}

function updateActionParams() {
    const action = document.getElementById('scheduleAction').value;
    // 隐藏所有参数区域
    document.querySelectorAll('.schedule-param-group').forEach(el => el.style.display = 'none');

    // 全局动作隐藏目标设备区域
    const targetGroup = document.getElementById('scheduleTargetGroup');
    if (targetGroup) {
        targetGroup.style.display = isGlobalAction(action) ? 'none' : '';
    }

    // 显示对应参数
    switch (action) {
        case 'play_playlist':
            show('paramPlaylist');
            break;
        case 'play_playlist_from':
            show('paramPlaylist');
            show('paramStartIndex');
            break;
        case 'set_play_mode':
            show('paramPlayMode');
            break;
        case 'set_volume':
            show('paramVolume');
            break;
    }

    function show(id) {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
    }
}

function updateScheduleTypeUI() {
    const type = document.getElementById('scheduleType').value;
    const weekdayGroup = document.getElementById('scheduleWeekdayGroup');
    const monthdayGroup = document.getElementById('scheduleMonthdayGroup');

    if (weekdayGroup) weekdayGroup.style.display = type === 'weekly' ? '' : 'none';
    if (monthdayGroup) monthdayGroup.style.display = type === 'monthly' ? '' : 'none';
}

function selectAllWeekdays() {
    document.querySelectorAll('.weekday-checkbox').forEach(cb => cb.checked = true);
}

function selectWorkdays() {
    document.querySelectorAll('.weekday-checkbox').forEach(cb => {
        const day = parseInt(cb.value);
        cb.checked = day >= 1 && day <= 5;
    });
}

/**
 * 渲染定时任务表单中的设备选择列表
 * @param {Array} selectedDevices - 已选中设备 [{account_id, device_id}]
 */
function renderScheduleDeviceList(selectedDevices = []) {
    const container = document.getElementById('scheduleDeviceList');
    if (!container) return;

    const allAccounts = getAllAccountDevices();
    const managedDevices = [];

    allAccounts.forEach(acc => {
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
            const isChecked = selectedDevices.some(
                s => s.account_id === dev.accountId && s.device_id === dev.deviceId
            );
            html += `<label class="schedule-device-item">` +
                `<input type="checkbox" class="schedule-device-checkbox" ` +
                `data-account-id="${dev.accountId}" data-device-id="${dev.deviceId}" ` +
                `${isChecked ? 'checked' : ''}>` +
                `<span>${escapeHtml(dev.deviceName)}</span>` +
                (dev.hardware ? `<span class="schedule-device-hw">${escapeHtml(dev.hardware)}</span>` : '') +
                `</label>`;
        });
    }
    container.innerHTML = html;
}

/** 根据"全选"状态切换设备列表显示/隐藏 */
function updateDeviceListVisibility() {
    const allChecked = document.getElementById('scheduleTargetAll').checked;
    const listContainer = document.getElementById('scheduleDeviceListContainer');
    if (listContainer) {
        listContainer.style.display = allChecked ? 'none' : '';
    }
}

// ========== 保存任务 ==========

function saveScheduleTask() {
    const name = document.getElementById('scheduleName').value.trim();
    if (!name) {
        showSnackbar('请输入任务名称', 'error');
        return;
    }

    const action = document.getElementById('scheduleAction').value;
    const scheduleType = document.getElementById('scheduleType').value;
    const time = document.getElementById('scheduleTime').value;
    const targetAll = document.getElementById('scheduleTargetAll').checked;

    // 收集日期选择
    let weekdays = [];
    let monthdays = [];
    if (scheduleType === 'weekly') {
        document.querySelectorAll('.weekday-checkbox:checked').forEach(cb => {
            weekdays.push(parseInt(cb.value));
        });
        if (weekdays.length === 0) {
            showSnackbar('请至少选择一天', 'error');
            return;
        }
    } else if (scheduleType === 'monthly') {
        document.querySelectorAll('.monthday-checkbox:checked').forEach(cb => {
            monthdays.push(parseInt(cb.value));
        });
        if (monthdays.length === 0) {
            showSnackbar('请至少选择一天', 'error');
            return;
        }
    }

    // 构建参数
    const params = {};
    if (!isGlobalAction(action)) {
        if (action === 'play_playlist' || action === 'play_playlist_from') {
            const playlistSelect = document.getElementById('schedulePlaylistSelect');
            const pid = playlistSelect ? playlistSelect.value : '';
            if (!pid) {
                showSnackbar('请选择歌单', 'error');
                return;
            }
            // 只保存歌单名称，执行时通过名称查找
            const pl = cachedPlaylists.find(p => String(p.id) === pid);
            params.playlist_name = pl ? pl.name : (playlistSelect.options[playlistSelect.selectedIndex]?.textContent || '');
        }
        if (action === 'play_playlist_from') {
            const songSelect = document.getElementById('scheduleSongSelect');
            // 只保存歌曲名称，执行时通过名称查找
            if (songSelect && songSelect.selectedIndex > 0) {
                const songText = songSelect.options[songSelect.selectedIndex].textContent;
                // 去掉序号前缀 "1. " 只保留歌曲标题
                params.song_name = songText.replace(/^\d+\.\s*/, '');
            }
        }
        if (action === 'set_play_mode') {
            params.play_mode = document.getElementById('schedulePlayMode').value;
        }
        if (action === 'set_volume') {
            params.volume = parseInt(document.getElementById('scheduleVolume').value) || 50;
        }
    }

    // 构建目标（全局动作自动设为全选，executor 会忽略）
    const target = isGlobalAction(action) ? { all_managed: true } : { all_managed: targetAll };
    if (!isGlobalAction(action) && !targetAll) {
        const devices = [];
        document.querySelectorAll('.schedule-device-checkbox:checked').forEach(cb => {
            devices.push({
                account_id: cb.dataset.accountId,
                device_id: cb.dataset.deviceId,
            });
        });
        if (devices.length === 0) {
            showSnackbar('请至少选择一个目标设备', 'error');
            return;
        }
        target.devices = devices;
    }

    // 节假日模式(仅对 weekly 生效)
    let holidayMode = 'ignore';
    const hmEl = document.getElementById('scheduleHolidayMode');
    if (hmEl && hmEl.value) holidayMode = hmEl.value;

    const taskData = {
        name: name,
        action: action,
        schedule: {
            type: scheduleType,
            time: time,
            weekdays: scheduleType === 'weekly' ? weekdays : undefined,
            monthdays: scheduleType === 'monthly' ? monthdays : undefined,
            holiday_mode: scheduleType === 'weekly' ? holidayMode : undefined,
        },
        target: target,
        params: params,
    };

    if (editingTaskId) {
        // 更新
        taskData.id = editingTaskId;
        apiPost('/schedules/update', taskData)
            .then(data => {
                if (data.success) {
                    showSnackbar('任务已更新', 'success');
                    closeScheduleForm();
                    loadSchedules();
                } else {
                    showSnackbar('更新失败：' + (data.error || '未知错误'), 'error');
                }
            })
            .catch(err => showSnackbar('更新失败：' + err.message, 'error'));
    } else {
        // 新建
        apiPost('/schedules', taskData)
            .then(data => {
                if (data.success) {
                    showSnackbar('任务已添加', 'success');
                    closeScheduleForm();
                    loadSchedules();
                } else {
                    showSnackbar('添加失败：' + (data.error || '未知错误'), 'error');
                }
            })
            .catch(err => showSnackbar('添加失败：' + err.message, 'error'));
    }
}

// ========== 任务操作（挂载到 window） ==========

window._editScheduleTask = function(id) {
    openScheduleForm(id);
};

window._toggleScheduleTask = function(id, enabled) {
    apiPost('/schedules/toggle', { id: id, enabled: enabled })
        .then(data => {
            if (data.success) {
                showSnackbar(enabled ? '任务已启用' : '任务已禁用', 'success');
                loadSchedules();
            } else {
                showSnackbar('操作失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(err => showSnackbar('操作失败：' + err.message, 'error'));
};

window._deleteScheduleTask = function(id) {
    if (!confirm('确定要删除此定时任务吗？')) return;
    apiDelete('/schedules?id=' + encodeURIComponent(id))
        .then(data => {
            if (data.success) {
                showSnackbar('任务已删除', 'success');
                loadSchedules();
            } else {
                showSnackbar('删除失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(err => showSnackbar('删除失败：' + err.message, 'error'));
};

// ========== 执行日志 ==========

let logsVisible = false;

function toggleScheduleLogs() {
    const panel = document.getElementById('scheduleLogsPanel');
    if (!panel) return;

    logsVisible = !logsVisible;
    if (logsVisible) {
        panel.style.display = 'block';
        loadScheduleLogs();
    } else {
        panel.style.display = 'none';
    }
}

function loadScheduleLogs() {
    apiGet('/schedules/logs?limit=50').then(data => {
        if (data.success && data.data) {
            renderScheduleLogs(data.data.logs || []);
        }
    }).catch(err => console.error('加载执行日志失败:', err));
}

function renderScheduleLogs(logs) {
    const listEl = document.getElementById('scheduleLogList');
    if (!listEl) return;

    if (!logs || logs.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">暂无执行记录</div>';
        return;
    }

    // 倒序显示（最新的在前）
    const sorted = [...logs].reverse();
    listEl.innerHTML = sorted.map(log => {
        const time = new Date(log.executed_at).toLocaleString('zh-CN');
        const statusIcon = log.success ? 'check_circle' : 'error';
        const statusClass = log.success ? 'log-success' : 'log-error';
        return `<div class="schedule-log-item ${statusClass}">` +
            `<span class="material-symbols-outlined" style="font-size:16px">${statusIcon}</span>` +
            `<div class="schedule-log-info">` +
            `<span class="schedule-log-name">${escapeHtml(log.task_name)}</span>` +
            `<span class="schedule-log-detail">${escapeHtml(log.device_name || log.device_id)} &middot; ${escapeHtml(log.message)}</span>` +
            `</div>` +
            `<span class="schedule-log-time">${time}</span>` +
            `</div>`;
    }).join('');
}

// ========== 音量滑块联动 ==========

// 在模块加载后绑定音量滑块事件
document.addEventListener('DOMContentLoaded', () => {
    const volumeSlider = document.getElementById('scheduleVolume');
    const volumeLabel = document.getElementById('scheduleVolumeLabel');
    if (volumeSlider && volumeLabel) {
        volumeSlider.addEventListener('input', function() {
            volumeLabel.textContent = this.value + '%';
        });
    }
});
