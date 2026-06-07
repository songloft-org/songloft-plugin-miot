/**
 * 配置管理模块
 * 负责主程序地址等配置的加载和保存
 */

const { apiGet, apiPost, apiDelete, getAuthToken } = SongloftPlugin;
import { showSnackbar } from './utils.js';

// 对话记录轮询定时器
let conversationPollTimer = null;
let lastConversationTimestamp = 0;

/**
 * 自动填充主程序地址
 * 使用当前页面的基础 URL 作为主程序地址
 */
export function autoFillServerHost() {
    const input = document.getElementById('serverHost');
    if (!input) return;

    const currentUrl = window.location.origin;
    input.value = currentUrl;
    showSnackbar('已自动填充：' + currentUrl, 'success');
}

/**
 * 加载配置
 * 从服务器获取主程序地址等配置信息
 */
export function loadConfig() {
    apiGet('/config').then(data => {
        if (data.success && data.data) {
            const serverHostInput = document.getElementById('serverHost');
            if (serverHostInput) {
                serverHostInput.value = data.data.server_host || '';
            }

            // 根据 server_host_status 显示/隐藏警告
            updateServerHostWarning(data.data.server_host_status);

            // 设置对话监听开关状态
            const enabled = !!data.data.conversation_monitor_enabled;
            const switchEl = document.getElementById('conversationMonitorSwitch');
            if (switchEl) {
                switchEl.checked = enabled;
            }
            updateConversationStatus(enabled);

            // 如果已启用，启动轮询并加载状态
            if (enabled) {
                startConversationPoll();
                loadConversationStatus();
            }

            // 设置语音口令开关状态
            const voiceEnabled = !!data.data.voice_command_enabled;
            const voiceSwitchEl = document.getElementById('voiceCommandSwitch');
            if (voiceSwitchEl) {
                voiceSwitchEl.checked = voiceEnabled;
            }
            updateVoiceCommandStatus(voiceEnabled);

            // 音频格式开关
            const forceMp3 = !!data.data.force_mp3;
            const forceMp3Switch = document.getElementById('forceMp3Switch');
            if (forceMp3Switch) {
                forceMp3Switch.checked = forceMp3;
            }

            // 自定义 Music API 型号
            const extraModelsInput = document.getElementById('extraMusicApiModelsInput');
            if (extraModelsInput) {
                const models = data.data.extra_music_api_models || [];
                extraModelsInput.value = models.join(', ');
            }

            // 外部搜索开关及配置
            const externalSearchEnabled = !!data.data.external_search_enabled;
            const externalSearchSwitch = document.getElementById('externalSearchSwitch');
            if (externalSearchSwitch) {
                externalSearchSwitch.checked = externalSearchEnabled;
            }
            updateExternalSearchConfig(externalSearchEnabled);

            const externalSearchUrlInput = document.getElementById('externalSearchUrlInput');
            if (externalSearchUrlInput) {
                externalSearchUrlInput.value = data.data.external_search_url || '';
            }
            const externalSearchTokenInput = document.getElementById('externalSearchTokenInput');
            if (externalSearchTokenInput) {
                externalSearchTokenInput.value = data.data.external_search_token || '';
            }

            // 时区
            const timezoneSelect = document.getElementById('timezoneSelect');
            if (timezoneSelect && data.data.timezone) {
                timezoneSelect.value = data.data.timezone;
            }

            // 加载语音口令配置
            loadVoiceCommands();

            // 加载 AI 配置
            if (data.data.ai_config) {
                loadAIConfig(data.data.ai_config);
            }
        }
    }).catch(error => {
        console.error('加载配置失败:', error);
    });
}

/**
 * 保存配置
 * 保存主程序地址等配置到服务器
 */
export function saveConfig() {
    const serverHostInput = document.getElementById('serverHost');
    let serverHost = serverHostInput ? serverHostInput.value.trim() : '';

    if (serverHost && !serverHost.startsWith('http://') && !serverHost.startsWith('https://')) {
        serverHost = window.location.protocol + '//' + serverHost;
        if (serverHostInput) {
            serverHostInput.value = serverHost;
        }
    }

    apiPost('/config', { server_host: serverHost })
        .then(data => {
            if (data.success) {
                if (data.warning) {
                    showSnackbar(data.warning, 'warning');
                    // 根据当前值更新警告状态
                    const status = !serverHost ? 'empty' : 'loopback';
                    updateServerHostWarning(status);
                } else {
                    showSnackbar('配置保存成功', 'success');
                    updateServerHostWarning('ok');
                }
                if (window.tracely) {
                    window.tracely.reportEvent('config_save', { server_host: serverHost });
                }
            } else {
                showSnackbar('保存配置失败：' + (data.error || '未知错误'), 'error');
                if (window.tracely) {
                    window.tracely.reportEvent('api_error', { path: '/config', error: data.error || '未知错误' });
                }
            }
        })
        .catch(error => {
            showSnackbar('保存配置失败：' + error.message, 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/config', error: error.message });
            }
        });
}

// ========== 服务器地址警告 ==========

/**
 * 根据服务器地址状态更新警告显示
 * @param {string} status - 'ok' | 'empty' | 'loopback'
 */
function updateServerHostWarning(status) {
    const warningEl = document.getElementById('serverHostWarning');
    const warningText = document.getElementById('serverHostWarningText');
    if (!warningEl || !warningText) return;

    if (status === 'empty') {
        warningText.textContent = '服务器地址为空，MIoT 智能音箱将无法播放音乐。请配置局域网 IP 地址（如 http://192.168.x.x:58091）。';
        warningEl.style.display = 'flex';
    } else if (status === 'loopback') {
        warningText.textContent = '服务器地址为本地回环地址（localhost/127.0.0.1），MIoT 智能音箱无法通过此地址访问服务器。请使用局域网 IP 地址（如 http://192.168.x.x:58091）。';
        warningEl.style.display = 'flex';
    } else {
        warningEl.style.display = 'none';
    }
}

// ========== 音频格式 ==========

/**
 * 初始化音频格式开关 UI 事件
 */
export function initForceMp3UI() {
    const switchEl = document.getElementById('forceMp3Switch');
    if (switchEl) {
        switchEl.addEventListener('change', function() {
            toggleForceMp3(this.checked);
        });
    }
}

// ========== 自定义 Music API 型号 ==========

/**
 * 初始化自定义 Music API 型号 UI 事件
 */
export function initExtraMusicApiModelsUI() {
    const saveBtn = document.getElementById('saveExtraMusicApiModelsBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveExtraMusicApiModels);
    }
}

function saveExtraMusicApiModels() {
    const input = document.getElementById('extraMusicApiModelsInput');
    if (!input) return;

    const raw = input.value.trim();
    const models = raw
        ? raw.split(/[,，\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
        : [];

    apiPost('/config', { extra_music_api_models: models })
        .then(data => {
            if (data.success) {
                input.value = models.join(', ');
                showSnackbar('自定义型号已保存', 'success');
            } else {
                showSnackbar('保存失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            showSnackbar('保存失败：' + error.message, 'error');
        });
}

// ========== 外部搜索配置 ==========

function updateExternalSearchConfig(enabled) {
    const panel = document.getElementById('externalSearchConfigPanel');
    if (panel) {
        panel.style.display = enabled ? 'block' : 'none';
    }
}

function saveExternalSearchConfig() {
    const switchEl = document.getElementById('externalSearchSwitch');
    const urlInput = document.getElementById('externalSearchUrlInput');
    const tokenInput = document.getElementById('externalSearchTokenInput');
    const enabled = switchEl ? switchEl.checked : false;
    const url = urlInput ? urlInput.value.trim() : '';
    const token = tokenInput ? tokenInput.value.trim() : '';

    apiPost('/config', { external_search_enabled: enabled, external_search_url: url, external_search_token: token })
        .then(data => {
            if (data.success) {
                showSnackbar('外部搜索配置已保存', 'success');
            } else {
                showSnackbar('保存失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            showSnackbar('保存失败：' + error.message, 'error');
        });
}

/**
 * 初始化外部搜索配置 UI
 */
export function initExternalSearchUI() {
    const switchEl = document.getElementById('externalSearchSwitch');
    if (switchEl) {
        switchEl.addEventListener('change', function() {
            updateExternalSearchConfig(this.checked);
        });
    }

    const saveBtn = document.getElementById('saveExternalSearchBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveExternalSearchConfig);
    }

    const testBtn = document.getElementById('externalSearchTestBtn');
    const testInput = document.getElementById('externalSearchTestInput');
    const testResult = document.getElementById('externalSearchTestResult');
    if (testBtn && testInput && testResult) {
        testBtn.addEventListener('click', async function() {
            const keyword = testInput.value.trim();
            if (!keyword) {
                testResult.style.display = 'block';
                testResult.style.color = 'var(--md-error)';
                testResult.textContent = '请输入搜索关键字';
                return;
            }

            testBtn.disabled = true;
            testResult.style.display = 'block';
            testResult.style.color = 'var(--md-on-surface-variant)';
            testResult.textContent = '测试中...';

            try {
                const url = document.getElementById('externalSearchUrlInput')?.value.trim();
                if (!url) {
                    testResult.style.color = 'var(--md-error)';
                    testResult.textContent = '请先配置搜索 API 地址';
                    return;
                }

                let fullUrl = url;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    // 相对路径，拼接当前域名
                    fullUrl = window.location.origin + url;
                }

                let token = document.getElementById('externalSearchTokenInput')?.value.trim();
                const headers = { 'Content-Type': 'application/json' };
                if (!token) {
                    token = getAuthToken();
                }
                if (token) {
                    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
                }

                const resp = await fetch(fullUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ keyword, quality: '320k' }),
                });

                const text = await resp.text();
                let json;
                try {
                    json = JSON.parse(text);
                    json = JSON.stringify(json, null, 2);
                } catch {
                    json = text;
                }
                testResult.style.color = resp.ok ? 'var(--md-primary)' : 'var(--md-error)';
                testResult.textContent = `状态: ${resp.status}\n\n${json}`;
            } catch (e) {
                testResult.style.color = 'var(--md-error)';
                testResult.textContent = '请求失败: ' + e.message;
            } finally {
                testBtn.disabled = false;
            }
        });
    }
}

/**
 * 切换强制 MP3 开关
 */
function toggleForceMp3(enabled) {
    apiPost('/config', { force_mp3: enabled })
        .then(data => {
            if (data.success) {
                showSnackbar(enabled ? '已开启统一转为 MP3' : '已关闭统一转为 MP3', 'success');
            } else {
                showSnackbar('操作失败：' + (data.error || '未知错误'), 'error');
                const switchEl = document.getElementById('forceMp3Switch');
                if (switchEl) switchEl.checked = !enabled;
            }
        })
        .catch(error => {
            showSnackbar('操作失败：' + error.message, 'error');
            const switchEl = document.getElementById('forceMp3Switch');
            if (switchEl) switchEl.checked = !enabled;
        });
}

// ========== 对话监听功能 ==========

/**
 * 初始化对话监听 UI 事件
 */
export function initConversationUI() {
    // 开关事件
    const switchEl = document.getElementById('conversationMonitorSwitch');
    if (switchEl) {
        switchEl.addEventListener('change', function() {
            toggleConversationMonitor(this.checked);
        });
    }

    // 添加 Webhook 按钮
    const addBtn = document.getElementById('addWebhookBtn');
    if (addBtn) {
        addBtn.addEventListener('click', addWebhook);
    }

    // 刷新对话记录按钮
    const refreshBtn = document.getElementById('refreshConversationBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadConversationMessages);
    }
}

/**
 * 切换对话监听开关
 */
function toggleConversationMonitor(enabled) {
    apiPost('/config', { conversation_monitor_enabled: enabled })
        .then(data => {
            if (data.success) {
                showSnackbar(enabled ? '对话监听已开启' : '对话监听已关闭', 'success');
                updateConversationStatus(enabled);
                if (enabled) {
                    startConversationPoll();
                    loadConversationStatus();
                } else {
                    stopConversationPoll();
                }
            } else {
                showSnackbar('操作失败：' + (data.error || '未知错误'), 'error');
                // 恢复开关状态
                const switchEl = document.getElementById('conversationMonitorSwitch');
                if (switchEl) switchEl.checked = !enabled;
            }
        })
        .catch(error => {
            showSnackbar('操作失败：' + error.message, 'error');
            const switchEl = document.getElementById('conversationMonitorSwitch');
            if (switchEl) switchEl.checked = !enabled;
        });
}

/**
 * 更新对话监听状态文本
 */
function updateConversationStatus(enabled) {
    const statusText = document.getElementById('conversationStatusText');
    const statusPanel = document.getElementById('conversationStatusPanel');
    if (statusText) {
        statusText.textContent = enabled ? '监听中...' : '已关闭';
    }
    if (statusPanel) {
        statusPanel.style.display = enabled ? 'block' : 'none';
    }
}

/**
 * 加载对话监听状态
 */
function loadConversationStatus() {
    apiGet('/conversation/status').then(data => {
        if (data.success && data.data) {
            const status = data.data;
            const chipsEl = document.getElementById('conversationDeviceChips');
            if (chipsEl && status.devices) {
                chipsEl.innerHTML = status.devices.map(dev =>
                    `<span class="status-chip ${dev.is_running ? 'chip-active' : 'chip-inactive'}">` +
                    `<span class="material-symbols-outlined" style="font-size:14px">${dev.is_running ? 'radio_button_checked' : 'radio_button_unchecked'}</span>` +
                    `${dev.device_name || dev.device_id}` +
                    `</span>`
                ).join('');
            }
            const statusText = document.getElementById('conversationStatusText');
            if (statusText && status.is_enabled) {
                statusText.textContent = `监听中 (${status.device_count} 台设备)`;
            }
        }
    }).catch(err => console.error('加载监听状态失败:', err));
}

/**
 * 开始对话记录轮询（每 2 秒）
 */
function startConversationPoll() {
    stopConversationPoll();
    loadConversationMessages();
    conversationPollTimer = setInterval(loadConversationMessages, 2000);
}

/**
 * 停止对话记录轮询
 */
function stopConversationPoll() {
    if (conversationPollTimer) {
        clearInterval(conversationPollTimer);
        conversationPollTimer = null;
    }
}

/**
 * 加载对话记录
 */
function loadConversationMessages() {
    const params = lastConversationTimestamp > 0 ? `?since=${lastConversationTimestamp}` : '?limit=50';
    apiGet('/conversation/messages' + params).then(data => {
        if (data.success && data.data && data.data.length > 0) {
            const listEl = document.getElementById('conversationList');
            if (!listEl) return;

            // 如果是首次加载，清空空状态
            if (lastConversationTimestamp === 0) {
                listEl.innerHTML = '';
            }

            data.data.forEach(item => {
                const msg = item.message;
                const ts = msg.timestamp_ms;
                if (ts > lastConversationTimestamp) {
                    lastConversationTimestamp = ts;
                }

                // 提取问题和回答
                let question = '';
                let answer = '';
                if (msg.response && msg.response.answer && msg.response.answer.length > 0) {
                    const ans = msg.response.answer[0];
                    question = ans.question || '';
                    answer = ans.content || '';
                }

                const timeStr = new Date(ts).toLocaleTimeString('zh-CN');
                const itemEl = document.createElement('div');
                itemEl.className = 'conversation-item';
                itemEl.innerHTML =
                    `<div class="conversation-meta">` +
                    `<span class="conversation-device">${item.device_name || item.device_id}</span>` +
                    `<span class="conversation-time">${timeStr}</span>` +
                    `</div>` +
                    (question ? `<div class="conversation-question"><span class="material-symbols-outlined" style="font-size:14px">person</span> ${escapeHtml(question)}</div>` : '') +
                    (answer ? `<div class="conversation-answer"><span class="material-symbols-outlined" style="font-size:14px">smart_toy</span> ${escapeHtml(answer)}</div>` : '');

                // 插入到列表顶部（最新的在前）
                listEl.insertBefore(itemEl, listEl.firstChild);
            });

            // 限制列表最多显示 100 条
            while (listEl.children.length > 100) {
                listEl.removeChild(listEl.lastChild);
            }
        }
    }).catch(err => console.error('加载对话记录失败:', err));
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== Webhook 管理 ==========

/**
 * 加载 Webhook 列表
 */
export function loadWebhooks() {
    apiGet('/conversation/webhooks').then(data => {
        if (data.success && data.data) {
            renderWebhookList(data.data);
        }
    }).catch(err => console.error('加载 Webhooks 失败:', err));
}

/**
 * 渲染 Webhook 列表
 */
function renderWebhookList(webhooks) {
    const listEl = document.getElementById('webhookList');
    if (!listEl) return;

    if (!webhooks || webhooks.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">暂无 Webhook</div>';
        return;
    }

    listEl.innerHTML = webhooks.map(wh =>
        `<div class="webhook-item">` +
        `<div class="webhook-info">` +
        `<span class="webhook-url">${escapeHtml(wh.url)}</span>` +
        (wh.name ? `<span class="webhook-name">${escapeHtml(wh.name)}</span>` : '') +
        `</div>` +
        `<button class="btn-icon btn-sm" onclick="window._deleteWebhook('${wh.id}')" title="删除">` +
        `<span class="material-symbols-outlined" style="font-size:18px">delete</span>` +
        `</button>` +
        `</div>`
    ).join('');
}

/**
 * 添加 Webhook
 */
function addWebhook() {
    const input = document.getElementById('webhookUrlInput');
    if (!input) return;

    const url = input.value.trim();
    if (!url) {
        showSnackbar('请输入回调 URL', 'error');
        return;
    }

    apiPost('/conversation/webhooks', { url: url })
        .then(data => {
            if (data.success) {
                showSnackbar('Webhook 添加成功', 'success');
                input.value = '';
                loadWebhooks();
            } else {
                showSnackbar('添加失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            showSnackbar('添加失败：' + error.message, 'error');
        });
}

/**
 * 删除 Webhook（挂载到 window 供 onclick 调用）
 */
window._deleteWebhook = function(id) {
    apiDelete('/conversation/webhooks?id=' + encodeURIComponent(id))
        .then(data => {
            if (data.success) {
                showSnackbar('Webhook 已删除', 'success');
                loadWebhooks();
            } else {
                showSnackbar('删除失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            showSnackbar('删除失败：' + error.message, 'error');
        });
};

// ========== 语音口令功能 ==========

/** 口令类型显示名称映射 */
const voiceCommandTypeLabels = {
    'play_playlist': '播放歌单',
    'play_song': '播放歌曲',
    'set_play_mode': '播放模式',
    'set_volume': '音量控制',
    'next': '下一首',
    'previous': '上一首',
    'stop': '停止播放',
};

/** 口令类型图标映射 */
const voiceCommandTypeIcons = {
    'play_playlist': 'queue_music',
    'play_song': 'music_note',
    'set_play_mode': 'repeat',
    'set_volume': 'volume_up',
    'next': 'skip_next',
    'previous': 'skip_previous',
    'stop': 'stop',
};

/** 播放模式参数显示名称 */
const playModeParamLabels = {
    'random': '随机播放',
    'single': '单曲循环',
    'loop': '列表循环',
    'order': '顺序播放',
};

/** 音量参数显示名称 */
const volumeParamLabels = {
    'absolute': '绝对音量',
    'up': '增大音量',
    'down': '减小音量',
};

/** 当前口令配置缓存 */
let currentVoiceCommands = [];

/**
 * 初始化语音口令 UI 事件
 */
export function initVoiceCommandUI() {
    // 开关事件
    const switchEl = document.getElementById('voiceCommandSwitch');
    if (switchEl) {
        switchEl.addEventListener('change', function() {
            toggleVoiceCommand(this.checked);
        });
    }

    // 恢复默认按钮
    const resetBtn = document.getElementById('resetVoiceCommandsBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetVoiceCommands);
    }
}

/**
 * 切换语音口令开关
 */
function toggleVoiceCommand(enabled) {
    apiPost('/config', { voice_command_enabled: enabled })
        .then(data => {
            if (data.success) {
                showSnackbar(enabled ? '语音口令已开启' : '语音口令已关闭', 'success');
                updateVoiceCommandStatus(enabled);
            } else {
                showSnackbar('操作失败：' + (data.error || '未知错误'), 'error');
                const switchEl = document.getElementById('voiceCommandSwitch');
                if (switchEl) switchEl.checked = !enabled;
            }
        })
        .catch(error => {
            showSnackbar('操作失败：' + error.message, 'error');
            const switchEl = document.getElementById('voiceCommandSwitch');
            if (switchEl) switchEl.checked = !enabled;
        });
}

/**
 * 更新语音口令状态文本
 */
function updateVoiceCommandStatus(enabled) {
    const statusText = document.getElementById('voiceCommandStatusText');
    if (statusText) {
        statusText.textContent = enabled ? '已开启' : '已关闭';
    }
}

/**
 * 加载语音口令配置
 */
export function loadVoiceCommands() {
    apiGet('/voice-commands').then(data => {
        if (data.success && data.data) {
            const { enabled, commands } = data.data;

            // 设置开关状态
            const switchEl = document.getElementById('voiceCommandSwitch');
            if (switchEl) switchEl.checked = !!enabled;
            updateVoiceCommandStatus(!!enabled);

            // 检查对话监听是否开启
            const monitorSwitch = document.getElementById('conversationMonitorSwitch');
            const hintEl = document.getElementById('voiceCommandDependencyHint');
            if (hintEl) {
                hintEl.style.display = (monitorSwitch && !monitorSwitch.checked) ? 'block' : 'none';
            }

            // 渲染口令列表
            currentVoiceCommands = commands || [];
            renderVoiceCommands(currentVoiceCommands);
        }
    }).catch(err => console.error('加载语音口令配置失败:', err));
}

/**
 * 渲染口令列表
 */
function renderVoiceCommands(commands) {
    const listEl = document.getElementById('voiceCommandList');
    if (!listEl) return;

    if (!commands || commands.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">暂无口令配置</div>';
        return;
    }

    // 按类型分组
    const groups = {};
    commands.forEach((cmd, index) => {
        const groupKey = cmd.type + (cmd.param ? '_' + cmd.param : '');
        if (!groups[groupKey]) {
            groups[groupKey] = { type: cmd.type, param: cmd.param, enabled: cmd.enabled, keywords: [...cmd.keywords], index: index };
        }
    });

    let html = '';
    commands.forEach((cmd, index) => {
        const typeLabel = voiceCommandTypeLabels[cmd.type] || cmd.type;
        const typeIcon = voiceCommandTypeIcons[cmd.type] || 'label';
        let paramLabel = '';
        if (cmd.type === 'set_play_mode' && cmd.param) {
            paramLabel = playModeParamLabels[cmd.param] || cmd.param;
        } else if (cmd.type === 'set_volume' && cmd.param) {
            paramLabel = volumeParamLabels[cmd.param] || cmd.param;
        }

        html += `<div class="voice-cmd-group">`;
        html += `<div class="voice-cmd-header">`;
        html += `<span class="material-symbols-outlined" style="font-size:18px">${typeIcon}</span>`;
        html += `<span class="voice-cmd-type-label">${typeLabel}</span>`;
        if (paramLabel) {
            html += `<span class="voice-cmd-param-tag">${paramLabel}</span>`;
        }
        html += `</div>`;

        // 口令词列表
        html += `<div class="voice-cmd-keywords">`;
        cmd.keywords.forEach((kw, kwIndex) => {
            html += `<span class="voice-cmd-keyword">`;
            html += `${escapeHtml(kw)}`;
            html += `<button class="voice-cmd-keyword-delete" onclick="window._removeKeyword(${index}, ${kwIndex})" title="删除">`;
            html += `<span class="material-symbols-outlined" style="font-size:14px">close</span>`;
            html += `</button>`;
            html += `</span>`;
        });
        html += `</div>`;

        // 添加口令词输入
        html += `<div class="voice-cmd-add-row">`;
        html += `<input type="text" class="text-field voice-cmd-add-input" id="addKeywordInput_${index}" placeholder="添加口令词" onkeydown="if(event.key==='Enter')window._addKeyword(${index})">`;
        html += `<button class="btn-text btn-sm" onclick="window._addKeyword(${index})">`;
        html += `<span class="material-symbols-outlined" style="font-size:16px">add</span>`;
        html += `</button>`;
        html += `</div>`;

        html += `</div>`;
    });

    listEl.innerHTML = html;
}

/**
 * 添加口令词
 */
window._addKeyword = function(cmdIndex) {
    const input = document.getElementById('addKeywordInput_' + cmdIndex);
    if (!input) return;

    const keyword = input.value.trim();
    if (!keyword) {
        showSnackbar('请输入口令词', 'error');
        return;
    }

    // 检查是否已存在
    if (currentVoiceCommands[cmdIndex].keywords.includes(keyword)) {
        showSnackbar('口令词已存在', 'error');
        return;
    }

    currentVoiceCommands[cmdIndex].keywords.push(keyword);
    input.value = '';
    saveVoiceCommands();
};

/**
 * 删除口令词
 */
window._removeKeyword = function(cmdIndex, kwIndex) {
    if (currentVoiceCommands[cmdIndex].keywords.length <= 1) {
        showSnackbar('至少保留一个口令词', 'error');
        return;
    }

    currentVoiceCommands[cmdIndex].keywords.splice(kwIndex, 1);
    saveVoiceCommands();
};

/**
 * 保存语音口令配置
 */
function saveVoiceCommands() {
    apiPost('/voice-commands', { commands: currentVoiceCommands })
        .then(data => {
            if (data.success) {
                renderVoiceCommands(currentVoiceCommands);
                showSnackbar('口令配置已保存', 'success');
            } else {
                showSnackbar('保存失败：' + (data.error || '未知错误'), 'error');
                loadVoiceCommands(); // 重新加载
            }
        })
        .catch(error => {
            showSnackbar('保存失败：' + error.message, 'error');
            loadVoiceCommands();
        });
}

/**
 * 恢复默认口令配置
 */
function resetVoiceCommands() {
    if (!confirm('确定要恢复默认口令配置吗？当前自定义的口令词将被覆盖。')) {
        return;
    }

    // 发送空数组让后端重置为默认
    apiPost('/voice-commands', { commands: [] })
        .then(data => {
            if (data.success) {
                showSnackbar('已恢复默认配置', 'success');
                loadVoiceCommands();
            } else {
                showSnackbar('恢复失败：' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            showSnackbar('恢复失败：' + error.message, 'error');
        });
}

/**
 * 加载设置数据
 * 加载配置（账号列表由 app.js 中的 Tab 切换逻辑触发）
 */
export function loadSettingsData() {
    loadConfig();
    loadWebhooks();
    loadVoiceCommands();
}

// ========== 时区设置 ==========

/**
 * 初始化时区设置 UI 事件
 */
export function initTimezoneUI() {
    const saveTimezoneBtn = document.getElementById('saveTimezoneBtn');
    if (saveTimezoneBtn) {
        saveTimezoneBtn.addEventListener('click', () => {
            const timezoneSelect = document.getElementById('timezoneSelect');
            const timezone = timezoneSelect ? timezoneSelect.value : 'Asia/Shanghai';
            apiPost('/config', { timezone: timezone })
                .then(data => {
                    if (data.success) {
                        showSnackbar('时区设置已保存', 'success');
                    } else {
                        showSnackbar('保存失败：' + (data.error || '未知错误'), 'error');
                    }
                })
                .catch(error => {
                    showSnackbar('保存失败：' + error.message, 'error');
                });
        });
    }
}

// ========== AI 分析配置 ==========

/**
 * 初始化 AI 配置 UI 事件
 */
export function initAIConfigUI() {
    // 开关事件
    const switchEl = document.getElementById('aiAnalysisSwitch');
    if (switchEl) {
        switchEl.addEventListener('change', function() {
            toggleAIAnalysis(this.checked);
        });
    }

    // 保存按钮
    const saveBtn = document.getElementById('saveAIConfigBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveAIConfig);
    }
}

/**
 * 加载 AI 配置到表单
 */
function loadAIConfig(aiConfig) {
    const enabled = !!aiConfig.enabled;
    const switchEl = document.getElementById('aiAnalysisSwitch');
    if (switchEl) {
        switchEl.checked = enabled;
    }
    updateAIConfigStatus(enabled);

    const panel = document.getElementById('aiConfigPanel');
    if (panel) {
        panel.style.display = enabled ? 'block' : 'none';
    }

    const apiUrlInput = document.getElementById('aiApiUrl');
    if (apiUrlInput && aiConfig.api_url) {
        apiUrlInput.value = aiConfig.api_url;
    }

    const apiKeyInput = document.getElementById('aiApiKey');
    if (apiKeyInput && aiConfig.api_key) {
        apiKeyInput.value = aiConfig.api_key;
    }

    const modelInput = document.getElementById('aiModel');
    if (modelInput && aiConfig.model) {
        modelInput.value = aiConfig.model;
    }

    const timeoutInput = document.getElementById('aiTimeout');
    if (timeoutInput && aiConfig.timeout) {
        timeoutInput.value = aiConfig.timeout;
    }
}

/**
 * 切换 AI 分析开关
 */
function toggleAIAnalysis(enabled) {
    apiPost('/config', { ai_config: { enabled } })
        .then(data => {
            if (data.success) {
                showSnackbar(enabled ? 'AI 分析已开启' : 'AI 分析已关闭', 'success');
                updateAIConfigStatus(enabled);
                const panel = document.getElementById('aiConfigPanel');
                if (panel) {
                    panel.style.display = enabled ? 'block' : 'none';
                }
            } else {
                showSnackbar('操作失败：' + (data.error || '未知错误'), 'error');
                const switchEl = document.getElementById('aiAnalysisSwitch');
                if (switchEl) switchEl.checked = !enabled;
            }
        })
        .catch(error => {
            showSnackbar('操作失败：' + error.message, 'error');
            const switchEl = document.getElementById('aiAnalysisSwitch');
            if (switchEl) switchEl.checked = !enabled;
        });
}

/**
 * 保存 AI 配置
 */
function saveAIConfig() {
    const apiUrl = document.getElementById('aiApiUrl')?.value.trim() || '';
    const apiKey = document.getElementById('aiApiKey')?.value.trim() || '';
    const model = document.getElementById('aiModel')?.value.trim() || 'qwen-flash';
    const timeout = parseInt(document.getElementById('aiTimeout')?.value, 10) || 6;

    apiPost('/config', {
        ai_config: {
            api_url: apiUrl,
            api_key: apiKey,
            model: model,
            timeout: timeout,
        }
    }).then(data => {
        if (data.success) {
            showSnackbar('AI 配置已保存', 'success');
        } else {
            showSnackbar('保存失败：' + (data.error || '未知错误'), 'error');
        }
    }).catch(error => {
        showSnackbar('保存失败：' + error.message, 'error');
    });
}

/**
 * 更新 AI 配置状态文本
 */
function updateAIConfigStatus(enabled) {
    const statusText = document.getElementById('aiAnalysisStatusText');
    if (statusText) {
        statusText.textContent = enabled ? '已开启' : '已关闭';
    }
}

// ========== 外部搜索接口规范 ==========

const EXTERNAL_SEARCH_SPEC = `

## 概述

💡 本接口用于在本地音乐搜索未命中时调用。接口方需按以下规范返回数据。
---

❗ **超时时间 6 秒**，超时则忽略本次搜索结果
---

## 搜索接口

**地址** \`用户配置\`
**请求方式** POST
**超时** 6 秒
**认证（可选）** \`Authorization: {用户配置}\`

---

## 请求体

\`\`\`json
{
  "keyword": "歌曲名称",
  "hint": {
    "title": "歌曲名称",
    "artist": "歌手名",
    "duration": 240
  },
  "quality": "320k"
}
\`\`\`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyword | string | 是 | 搜索关键词（歌曲名） |
| hint | object | 否 | 歌曲提示信息 |
| hint.title | string | 否 | 歌曲名称 |
| hint.artist | string | 否 | 歌手名称 |
| hint.duration | number | 否 | 时长（秒） |
| quality | string | 否 | 音质要求，默认 320k |

---

## 成功响应示例

\`\`\`json
{
  "code": 0,
  "msg": "success",
  "data": {
    "title": "演员",
    "artist": "薛之谦",
    "album": "几个薛之谦",
    "duration": 240,
    "cover_url": "https://example.com/cover.jpg",
    "url": "https://example.com/song.mp3",
    "source_data": {
      "platform": "netease",
      "quality": "320k",
      "songInfo": {
        "musicId": "123456",
        "songmid": "0034567890",
        "hash": "ABCD1234567890",
        "copyrightId": "789456",
        "types": [
          { "type": "128k", "size": "3.2MB" },
          { "type": "320k", "size": "8.1MB" }
        ]
      }
    }
  }
}
\`\`\`

| 字段 | 类型 | 说明 |
|------|------|------|
| code | number | 0=成功，非0=失败 |
| msg | string | 状态信息 |
| data.title | string | 歌曲名称 |
| data.artist | string | 歌手名称 |
| data.album | string | 专辑名称 |
| data.duration | number | 时长（秒） |
| data.cover_url | string | 封面图片 URL |
| data.url | string | 歌曲播放 URL |
| data.source_data | object | 非必须 |
| data.source_data.platform | string | 音源平台 |
| data.source_data.songInfo.musicId | string | 歌曲 ID |
| data.source_data.songInfo.hash | string | 歌曲哈希值 |

---

## 失败响应示例

\`\`\`json
{
  "code": 500,
  "msg": "搜索失败",
  "data": null
}
\`\`\`

---

## 错误码

| code | 说明 |
|------|------|
| 0 | 成功 |
| 400 | 请求参数错误 |
| 404 | 未找到歌曲 |
| 500 | 服务器内部错误 |

---
`;

/**
 * 显示外部搜索接口规范对话框
 */
function showExternalSearchSpec() {
    const dialogTitle = document.getElementById('dialogTitle');
    const dialogContent = document.getElementById('dialogContent');
    const dialogConfirmBtn = document.getElementById('dialogConfirmBtn');
    const dialogCancelBtn = document.getElementById('dialogCancelBtn');
    const dialogOverlay = document.getElementById('dialogOverlay');

    if (!dialogTitle || !dialogContent) return;

    dialogTitle.textContent = '接口规范';
    dialogConfirmBtn.style.display = 'none';
    dialogCancelBtn.textContent = '关闭';

    if (typeof marked !== 'undefined') {
        marked.setOptions({ breaks: true, gfm: true });
        dialogContent.innerHTML = '<div class="md-content">' + marked.parse(EXTERNAL_SEARCH_SPEC) + '</div>';
    } else {
        dialogContent.innerHTML = '<pre style="white-space:pre-wrap">' + escapeHtml(EXTERNAL_SEARCH_SPEC) + '</pre>';
    }

    dialogOverlay.classList.add('show');
}

/**
 * 初始化外部搜索接口规范链接事件
 */
export function initExternalSearchSpecUI() {
    const link = document.getElementById('externalSearchSpecLink');
    if (link) {
        link.addEventListener('click', showExternalSearchSpec);
    }
}
