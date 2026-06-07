/**
 * 播放控制模块
 * 负责播放/停止/切歌/播放模式/音量控制/设备状态
 */

const { apiGet, apiPost } = SongloftPlugin;
import { showSnackbar, showLoading, hideLoading, showResult, getAccountId, getDeviceId } from './utils.js';
import { getAllAccountDevices, getDeviceInfo, closeDeviceSelectPanel } from './device.js';
import { loadPlaylistSongs, highlightSongItem } from './playlist.js';

/** 播放进度相关状态 */
let currentPosition = 0;    // 当前播放位置（秒）
let currentDuration = 0;    // 歌曲总时长（秒）
let isCurrentlyPlaying = false; // 当前是否正在播放
let lastUpdateTime = 0;     // 上次同步时的 performance.now() 时间戳
let progressRAF = null;     // requestAnimationFrame ID

/**
 * 格式化时间为 m:ss 格式
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

/**
 * 更新进度条 DOM 元素
 * @param {number} position - 当前位置（秒）
 * @param {number} duration - 总时长（秒）
 */
function updateProgressDOM(position, duration) {
    const progressFill = document.getElementById('progressFill');
    const progressThumb = document.getElementById('progressThumb');
    const currentTimeEl = document.getElementById('currentTime');

    const percent = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;

    if (progressFill) progressFill.style.width = percent + '%';
    if (progressThumb) progressThumb.style.left = percent + '%';
    if (currentTimeEl) currentTimeEl.textContent = formatTime(position);
}

/**
 * 启动进度条动画（使用 requestAnimationFrame 实现平滑更新）
 */
function startProgressAnimation() {
    if (progressRAF) return; // 已在运行

    function animate() {
        if (!isCurrentlyPlaying) {
            progressRAF = null;
            return;
        }

        const now = performance.now();
        const elapsed = (now - lastUpdateTime) / 1000; // 转为秒
        const estimatedPosition = currentPosition + elapsed;

        // 不超过总时长
        const clampedPosition = currentDuration > 0
            ? Math.min(estimatedPosition, currentDuration)
            : estimatedPosition;

        updateProgressDOM(clampedPosition, currentDuration);

        progressRAF = requestAnimationFrame(animate);
    }

    progressRAF = requestAnimationFrame(animate);
}

/**
 * 停止进度条动画
 */
function stopProgressAnimation() {
    if (progressRAF) {
        cancelAnimationFrame(progressRAF);
        progressRAF = null;
    }
}

/** 音量设置防抖定时器 */
let volumeDebounceTimer = null;

/** 静音前保存的音量值 */
let lastVolumeBeforeMute = 50;

/** 播放模式列表（用于循环切换），使用 Material Symbols 图标 */
export const playModes = [
    { value: 'order', label: '顺序播放', icon: 'format_list_numbered' },
    { value: 'loop', label: '列表循环', icon: 'repeat' },
    { value: 'single', label: '单曲循环', icon: 'repeat_one' },
    { value: 'single-once', label: '单曲播放', icon: 'looks_one' },
    { value: 'random', label: '随机播放', icon: 'shuffle' }
];

/**
 * 停止播放
 */
export function stopPlaylist() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    showLoading();
    apiPost('/player/stop?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), {}).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('已停止播放', 'success');
            if (window.tracely) {
                window.tracely.reportEvent('song_stop', { account_id: accountId, device_id: deviceId });
            }
            loadDeviceStatus();
        } else {
            showSnackbar('停止失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/stop', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('停止失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/player/stop', error: error.message });
        }
    });
}

/**
 * 播放上一首
 */
export function previousSong() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    showLoading();
    apiPost('/player/previous?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), {}).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('已切换到上一首', 'success');
            if (window.tracely) {
                window.tracely.reportEvent('song_skip', { direction: 'prev', account_id: accountId, device_id: deviceId });
            }
            loadDeviceStatus();
        } else {
            showSnackbar('切换失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/previous', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('切换失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/player/previous', error: error.message });
        }
    });
}

/**
 * 播放下一首
 */
export function nextSong() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    showLoading();
    apiPost('/player/next?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), {}).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('已切换到下一首', 'success');
            if (window.tracely) {
                window.tracely.reportEvent('song_skip', { direction: 'next', account_id: accountId, device_id: deviceId });
            }
            loadDeviceStatus();
        } else {
            showSnackbar('切换失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/next', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('切换失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/player/next', error: error.message });
        }
    });
}

/**
 * 切换播放/暂停状态
 */
export function togglePlayPause() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    showLoading();
    apiPost('/player/toggle?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), {}).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('播放状态已切换', 'success');
            loadDeviceStatus();
        } else {
            showSnackbar('切换失败：' + (data.error || data.message || '未知错误'), 'error');
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('切换失败：' + error.message, 'error');
    });
}

/**
 * 根据 player/status 接口数据更新播放器 UI
 * @param {Object} status - player/status 接口返回的 data 对象
 */
export function updatePlayerUI(status) {
    if (!status) return;

    // 更新当前歌曲名称和歌手
    const currentSongTitleEl = document.getElementById('currentSongTitle');
    const currentSongArtistEl = document.getElementById('currentSongArtist');

    if (status.current_song) {
        if (currentSongTitleEl) {
            currentSongTitleEl.textContent = status.current_song.title || '未知歌曲';
        }
        if (currentSongArtistEl) {
            currentSongArtistEl.textContent = status.current_song.artist || '未知艺术家';
        }
    } else {
        if (currentSongTitleEl) currentSongTitleEl.textContent = '暂无播放';
        if (currentSongArtistEl) currentSongArtistEl.textContent = '-';
    }

    // 更新播放按钮图标
    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        const icon = playBtn.querySelector('.material-symbols-outlined');
        if (icon) {
            icon.textContent = status.is_playing ? 'pause' : 'play_arrow';
        }
    }

    // 更新播放模式按钮
    if (status.play_mode) {
        const modeInfo = playModes.find(m => m.value === status.play_mode);
        if (modeInfo) {
            updatePlayModeButton(modeInfo.value, modeInfo.label, modeInfo.icon);
        }
    }

    // 更新播放进度
    const totalTimeEl = document.getElementById('totalTime');
    if (status.duration !== undefined) {
        currentDuration = status.duration || 0;
        if (totalTimeEl) totalTimeEl.textContent = formatTime(currentDuration);
    }
    if (status.position !== undefined) {
        currentPosition = status.position || 0;
        lastUpdateTime = performance.now();
    }

    isCurrentlyPlaying = !!status.is_playing;
    if (isCurrentlyPlaying) {
        startProgressAnimation();
    } else {
        stopProgressAnimation();
        // 静态显示当前进度
        updateProgressDOM(currentPosition, currentDuration);
    }

    // 高亮当前播放歌曲
    if (status.current_index !== undefined && status.current_index >= 0) {
        highlightSongItem(status.current_index);
    }

}

/**
 * 获取播放状态并恢复上次的设备选择
 * @returns {Promise} 返回 Promise
 */
export function getPlayerStatus() {
    return new Promise((resolve, reject) => {
        // 静默读取，不触发 Snackbar 提示
        const accountId = window.currentAccountId || '';
        if (!accountId) {
            resolve({ success: false, message: 'account_id is required' });
            return;
        }
        const deviceId = window.currentDeviceId || '';
        if (!deviceId) {
            resolve({ success: false, message: 'device_id is required' });
            return;
        }

        apiGet('/player/status?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId)).then(data => {
            if (data.success && data.data) {
                // 更新播放器 UI
                updatePlayerUI(data.data);
                resolve(data);
            } else {
                // 没有播放状态也不算错误，可能是首次使用
                resolve(data);
            }
        }).catch(error => {
            reject(error);
        });
    });
}

/**
 * 更新播放模式按钮显示
 * @param {string} mode - 播放模式值
 * @param {string} label - 播放模式标签
 * @param {string} iconName - Material Symbols 图标名称
 */
export function updatePlayModeButton(mode, label, iconName) {
    const button = document.getElementById('playModeBtn');
    if (!button) return;

    button.setAttribute('data-mode', mode);
    button.setAttribute('title', label);

    const icon = button.querySelector('.material-symbols-outlined');
    if (icon && iconName) {
        icon.textContent = iconName;
    }
}

/**
 * 切换播放模式
 */
export function togglePlayMode() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const playModeBtn = document.getElementById('playModeBtn');
    const currentMode = playModeBtn ? (playModeBtn.getAttribute('data-mode') || 'loop') : 'loop';
    const currentIndex = playModes.findIndex(m => m.value === currentMode);
    const nextIndex = (currentIndex + 1) % playModes.length;
    const nextMode = playModes[nextIndex];

    updatePlayModeButton(nextMode.value, nextMode.label, nextMode.icon);

    showLoading();
    apiPost('/player/mode?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), { play_mode: nextMode.value }).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('播放模式：' + nextMode.label, 'success');
            if (window.tracely) {
                window.tracely.reportEvent('play_mode_change', { mode: nextMode.value, label: nextMode.label });
            }
        } else {
            showSnackbar('切换失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/mode', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('切换失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/player/mode', error: error.message });
        }
    });
}

/**
 * 设置音量
 */
export function setVolume() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const volumeSlider = document.getElementById('volumeSlider');
    const volume = volumeSlider ? parseInt(volumeSlider.value) : 50;

    showLoading();
    apiPost('/mina/volume', { account_id: accountId, device_id: deviceId, volume: volume }).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('音量：' + volume, 'success');
            if (window.tracely) {
                window.tracely.reportEvent('volume_change', { volume: volume });
            }
        } else {
            showSnackbar('音量设置失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/mina/volume', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('音量设置失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/mina/volume', error: error.message });
        }
    });
}

/**
 * 自动设置音量（带防抖）
 */
export function autoSetVolume() {
    if (volumeDebounceTimer) {
        clearTimeout(volumeDebounceTimer);
    }
    volumeDebounceTimer = setTimeout(() => {
        setVolume();
        updateVolumeIcon();
    }, 500);
}

/**
 * 更新音量图标显示
 * 根据当前音量值动态切换 Material Symbols 图标
 * @param {number} [volume] - 可选的音量值，不传则从滑块读取
 */
export function updateVolumeIcon(volume) {
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeIcon = document.getElementById('volumeIcon');
    const muteBtnIcon = document.getElementById('muteBtnIcon');
    const muteBtn = document.getElementById('muteBtn');

    if (!volumeSlider) return;

    const vol = volume !== undefined ? volume : parseInt(volumeSlider.value);
    let iconName;

    if (vol === 0) {
        iconName = 'volume_off';
        if (muteBtn) muteBtn.setAttribute('title', '取消静音');
    } else if (vol <= 29) {
        iconName = 'volume_mute';
        if (muteBtn) muteBtn.setAttribute('title', '静音');
    } else if (vol <= 69) {
        iconName = 'volume_down';
        if (muteBtn) muteBtn.setAttribute('title', '静音');
    } else {
        iconName = 'volume_up';
        if (muteBtn) muteBtn.setAttribute('title', '静音');
    }

    // 更新两个位置的图标
    if (volumeIcon) volumeIcon.textContent = iconName;
    if (muteBtnIcon) muteBtnIcon.textContent = iconName;
}

/**
 * 切换静音状态
 * 点击音量图标时切换静音/有声状态
 */
export function toggleMute() {
    const volumeSlider = document.getElementById('volumeSlider');
    const volumePercent = document.getElementById('volumePercent');
    if (!volumeSlider) return;

    const currentVolume = parseInt(volumeSlider.value);

    if (currentVolume > 0) {
        // 当前有声音，切换到静音
        lastVolumeBeforeMute = currentVolume;
        volumeSlider.value = 0;
        if (volumePercent) volumePercent.textContent = '0%';
        updateVolumeIcon(0);
        autoSetVolume();
        showSnackbar('已静音', 'info');
    } else {
        // 当前是静音，恢复音量
        const restoreVolume = lastVolumeBeforeMute > 0 ? lastVolumeBeforeMute : 50;
        volumeSlider.value = restoreVolume;
        if (volumePercent) volumePercent.textContent = restoreVolume + '%';
        updateVolumeIcon(restoreVolume);
        autoSetVolume();
        showSnackbar('已恢复音量', 'success');
    }
}

/**
 * 加载设备播放状态并更新 UI 显示
 * 从 player/status 接口获取实时状态
 */
export function loadDeviceStatus() {
    // 静默读取，不触发 Snackbar 提示（此函数由定时器每秒调用）
    const accountId = window.currentAccountId || '';
    if (!accountId) return;
    const deviceId = window.currentDeviceId || '';
    if (!deviceId) return;

    apiGet('/player/status?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId)).then(data => {
        if (data.success && data.data) {
            updatePlayerUI(data.data);
        }
    }).catch(error => {
        console.warn('获取播放状态失败', error);
    });
}

/**
 * 根据当前选中设备的缓存数据，将音量同步到 UI
 * 数据源：/mina/devices 接口返回的 device.volume（持久化属性）
 * 调用时机：设备列表刷新后、设备切换后、初始加载完成后
 * @param {Object} [options]
 * @param {boolean} [options.fallbackDefault=false] - 设备不存在或无 volume 字段时是否回退为 50%
 * @returns {boolean} 是否成功从设备读取并同步了音量
 */
export function syncVolumeFromDevice(options) {
    const opts = options || {};
    const accountId = getAccountId();
    if (!accountId) return false;
    const deviceId = getDeviceId();
    if (!deviceId) return false;

    const volumeSlider = document.getElementById('volumeSlider');
    const volumePercent = document.getElementById('volumePercent');
    if (!volumeSlider && !volumePercent) return false;

    const device = getDeviceInfo(accountId, deviceId);
    if (device && device.volume !== undefined && device.volume !== null) {
        const vol = parseInt(device.volume);
        if (volumeSlider) volumeSlider.value = vol;
        if (volumePercent) volumePercent.textContent = vol + '%';
        // 记录最后非静音音量，便于静音切换恢复
        if (vol > 0) lastVolumeBeforeMute = vol;
        updateVolumeIcon(vol);
        return true;
    }

    if (opts.fallbackDefault) {
        if (volumeSlider) volumeSlider.value = 50;
        if (volumePercent) volumePercent.textContent = '50%';
        updateVolumeIcon(50);
    }
    return false;
}

/**
 * 初始化播放控制区域
 * 音量从 mina/devices 中读取（持久化属性），播放状态从 player/status 接口获取
 */
export function initializePlaybackControls() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    // 从设备信息中读取音量（持久化属性）
    syncVolumeFromDevice({ fallbackDefault: true });

    // 播放状态（播放模式、当前歌曲等）从 player/status 接口获取
    loadDeviceStatus();
}

// ========== 弹出层控制函数 ==========

/**
 * 关闭所有弹出层
 */
export function closeAllPopups() {
    closePlayModePanel();
    closeVolumePanel();
    closeDeviceSelectPanel();
}

/**
 * 打开/关闭播放模式面板
 */
export function togglePlayModePanel() {
    const panel = document.getElementById('playModePanel');
    const backdrop = document.getElementById('playModeBackdrop');
    const btn = document.getElementById('playModeBtn');

    if (!panel || !backdrop || !btn) return;

    if (panel.classList.contains('show')) {
        closePlayModePanel();
        return;
    }

    // 先关闭其他弹出层
    closeAllPopups();

    // 定位面板 - 在按钮上方居中
    const rect = btn.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 156;
    let left = rect.left + rect.width / 2 - panelWidth / 2;
    if (left < 16) left = 16;
    if (left + panelWidth > window.innerWidth - 16) left = window.innerWidth - panelWidth - 16;

    // 默认在上方
    panel.style.left = left + 'px';
    panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    panel.style.top = 'auto';

    backdrop.style.display = '';
    panel.classList.add('show');

    // 更新选中状态
    updatePlayModeHighlight();
}

/**
 * 关闭播放模式面板
 */
export function closePlayModePanel() {
    const panel = document.getElementById('playModePanel');
    const backdrop = document.getElementById('playModeBackdrop');
    if (panel) panel.classList.remove('show');
    if (backdrop) backdrop.style.display = 'none';
}

/**
 * 选择播放模式
 * @param {string} mode - 播放模式
 */
export function selectPlayMode(mode) {
    closePlayModePanel();
    setPlayModeDirectly(mode);
}

/**
 * 直接设置播放模式（不循环切换）
 * @param {string} mode - 播放模式
 */
export function setPlayModeDirectly(mode) {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const modeInfo = playModes.find(m => m.value === mode);
    if (!modeInfo) return;

    updatePlayModeButton(modeInfo.value, modeInfo.label, modeInfo.icon);

    showLoading();
    apiPost('/player/mode?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), { play_mode: mode }).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('播放模式：' + modeInfo.label, 'success');
            if (window.tracely) {
                window.tracely.reportEvent('play_mode_change', { mode: modeInfo.value, label: modeInfo.label });
            }
        } else {
            showSnackbar('切换失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/mode', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('切换失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/player/mode', error: error.message });
        }
    });
}

/**
 * 更新播放模式选中状态
 */
function updatePlayModeHighlight() {
    const playModeBtn = document.getElementById('playModeBtn');
    const currentMode = playModeBtn ? (playModeBtn.getAttribute('data-mode') || 'loop') : 'loop';

    document.querySelectorAll('.play-mode-item').forEach(item => {
        item.classList.toggle('active', item.dataset.mode === currentMode);
    });
}

/**
 * 打开/关闭音量面板
 */
export function toggleVolumePanel() {
    const panel = document.getElementById('volumePanel');
    const backdrop = document.getElementById('volumeBackdrop');
    const btn = document.getElementById('volumePopupBtn');

    if (!panel || !backdrop || !btn) return;

    if (panel.classList.contains('show')) {
        closeVolumePanel();
        return;
    }

    // 先关闭其他弹出层
    closeAllPopups();

    // 定位面板 - 在按钮上方居中
    const rect = btn.getBoundingClientRect();
    const panelWidth = 56;
    let left = rect.left + rect.width / 2 - panelWidth / 2;
    if (left < 16) left = 16;
    if (left + panelWidth > window.innerWidth - 16) left = window.innerWidth - panelWidth - 16;

    panel.style.left = left + 'px';
    panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    panel.style.top = 'auto';

    backdrop.style.display = '';
    panel.classList.add('show');
}

/**
 * 关闭音量面板
 */
export function closeVolumePanel() {
    const panel = document.getElementById('volumePanel');
    const backdrop = document.getElementById('volumeBackdrop');
    if (panel) panel.classList.remove('show');
    if (backdrop) backdrop.style.display = 'none';
}
