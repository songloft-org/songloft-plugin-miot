/**
 * 播放控制模块
 * 负责播放/停止/切歌/播放模式/音量控制/设备状态
 */

const { apiGet, apiPost, getAuthToken } = SongloftPlugin;
import { showSnackbar, showLoading, hideLoading, showResult, getAccountId, getDeviceId } from './utils.js';
import { getAllAccountDevices, getDeviceInfo, closeDeviceSelectPanel } from './device.js';
import { loadPlaylistSongs, highlightSongItem } from './playlist.js';
import { parseLrc, getCurrentLyricIndex } from './lrc-parser.js';

const DEFAULT_FETCH_TIMEOUT_MS = 0;
const COVER_FETCH_TIMEOUT_MS = 3500;

/** 播放进度相关状态 */
let currentPosition = 0;    // 当前播放位置（秒）
let currentDuration = 0;    // 歌曲总时长（秒）
let isCurrentlyPlaying = false; // 当前是否正在播放
let lastUpdateTime = 0;     // 上次同步时的 performance.now() 时间戳
let progressRAF = null;     // requestAnimationFrame ID

/** 歌词相关状态 */
let currentLyrics = [];     // 解析后的歌词数组
let currentLyricUrl = '';   // 当前歌词 URL
let lyricFetchTimer = null; // 歌词获取防抖定时器
let lastBarLyricIndex = -1; // 播放栏当前高亮歌词行索引（去重，避免重复写 DOM）

/**
 * 根据播放位置更新播放栏当前歌词行。
 * 与全屏播放器一致，接受插值后的估算位置：播放栏歌词由 RAF 每帧驱动，
 * 而非只在状态帧到达时刷新，避免因后端 ~4s 设备缓存导致歌词慢几秒才更新。
 * @param {number} position - 当前播放位置（秒，可为 RAF 插值估算值）
 */
function updatePlayerBarLyric(position) {
    if (currentLyrics.length === 0) return;
    const idx = getCurrentLyricIndex(currentLyrics, position);
    if (idx === lastBarLyricIndex) return;
    lastBarLyricIndex = idx;
    if (idx >= 0) {
        const playerBarLyric = document.getElementById('playerBarLyric');
        if (playerBarLyric) playerBarLyric.textContent = currentLyrics[idx].text;
    }
}

/** toggle 防护时间戳（防止过期轮询覆盖 toggle 后的 UI 状态） */
let lastToggleMs = 0;

/** 播放栏封面 URL（防重复加载） */
let currentPlayerBarCoverUrl = '';
/** 播放栏封面 ObjectURL（供回收） */
let playerBarCoverObjectUrl = null;

/** 状态监听器列表 */
const statusListeners = [];

export function addStatusListener(fn) { statusListeners.push(fn); }
export function removeStatusListener(fn) {
    const idx = statusListeners.indexOf(fn);
    if (idx >= 0) statusListeners.splice(idx, 1);
}

export function getCurrentLyrics() { return currentLyrics; }
export function getCurrentPosition() { return currentPosition; }
export function getCurrentDuration() { return currentDuration; }
export function getIsPlaying() { return isCurrentlyPlaying; }
export function getLastUpdateTime() { return lastUpdateTime; }

/**
 * 格式化时间为 m:ss 格式
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间字符串
 */
export function formatTime(seconds) {
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
        updatePlayerBarLyric(clampedPosition);

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

/** 最近一次用户操作音量的时间戳，用于抑制轮询覆盖 */
let lastVolumeInteractTime = 0;

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
    lastToggleMs = Date.now();
    apiPost('/player/stop?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), {}).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            isCurrentlyPlaying = false;
            stopProgressAnimation();
            updateProgressDOM(currentPosition, currentDuration);
            const playBtn = document.getElementById('playBtn');
            if (playBtn) {
                const icon = playBtn.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = 'play_arrow';
            }
            const fpPlayBtn = document.getElementById('fpPlayBtn');
            if (fpPlayBtn) {
                const fpIcon = fpPlayBtn.querySelector('.material-symbols-outlined');
                if (fpIcon) fpIcon.textContent = 'play_arrow';
            }
            showSnackbar('已停止播放', 'success');
            if (window.tracely) {
                window.tracely.reportEvent('song_stop', { account_id: accountId, device_id: deviceId });
            }
            loadDeviceStatus(true);
        } else {
            lastToggleMs = 0;
            showSnackbar('停止失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/stop', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        lastToggleMs = 0;
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
    lastToggleMs = Date.now();
    apiPost('/player/toggle?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId), {}).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            if (data.data && data.data.state === 'stopped') {
                isCurrentlyPlaying = false;
                stopProgressAnimation();
                updateProgressDOM(currentPosition, currentDuration);
                const playBtn = document.getElementById('playBtn');
                if (playBtn) {
                    const icon = playBtn.querySelector('.material-symbols-outlined');
                    if (icon) icon.textContent = 'play_arrow';
                }
            }
            showSnackbar('播放状态已切换', 'success');
            loadDeviceStatus(true);
        } else {
            lastToggleMs = 0;
            showSnackbar('切换失败：' + (data.error || data.message || '未知错误'), 'error');
        }
    }).catch(error => {
        hideLoading();
        lastToggleMs = 0;
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

    // 更新歌词
    const playerBarLyric = document.getElementById('playerBarLyric');
    if (status.current_song && status.current_song.lyric_url) {
        const lyricUrl = status.current_song.lyric_url;
        if (lyricUrl !== currentLyricUrl) {
            currentLyricUrl = lyricUrl;
            lastBarLyricIndex = -1; // 换歌词源，重置高亮索引强制刷新
            fetchLyrics(status.current_song.id);
        }
    } else {
        currentLyricUrl = '';
        currentLyrics = [];
        lastBarLyricIndex = -1;
        if (playerBarLyric) playerBarLyric.textContent = '暂无歌词';
    }

    // 更新歌曲信息
    const currentSongTitleEl = document.getElementById('currentSongTitle');
    const currentSongArtistEl = document.getElementById('currentSongArtist');

    if (status.current_song) {
        if (currentSongTitleEl) currentSongTitleEl.textContent = status.current_song.title || '未知歌曲';
        if (currentSongArtistEl) currentSongArtistEl.textContent = status.current_song.artist || '未知艺术家';
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

    // stopped 状态强制归零，防止设备残留数据导致进度条跳动
    if (status.state === 'stopped') {
        currentPosition = 0;
    }

    isCurrentlyPlaying = !!status.is_playing;
    if (isCurrentlyPlaying) {
        startProgressAnimation();
    } else {
        stopProgressAnimation();
        updateProgressDOM(currentPosition, currentDuration);
        // 非播放态 RAF 不跑，在此直接同步一次播放栏歌词行（暂停/首帧）
        updatePlayerBarLyric(currentPosition);
    }

    // 高亮当前播放歌曲
    if (status.current_index !== undefined && status.current_index >= 0) {
        highlightSongItem(status.current_index);
    }

    // 同步设备实际音量到 UI（用户正在拖动或刚操作完 2 秒内跳过，避免覆盖）
    if (status.volume !== undefined && status.volume >= 0) {
        const volumeSlider = document.getElementById('volumeSlider');
        const volumePercent = document.getElementById('volumePercent');
        const recentlyInteracted = Date.now() - lastVolumeInteractTime < 2000;
        if (volumeSlider && !volumeSlider.matches(':active') && !recentlyInteracted) {
            volumeSlider.value = status.volume;
            if (volumePercent) volumePercent.textContent = status.volume + '%';
            if (status.volume > 0) lastVolumeBeforeMute = status.volume;
            updateVolumeIcon(status.volume);
        }
    }

    // 加载播放栏封面缩略图
    if (status.current_song && status.current_song.cover_url) {
        const coverUrl = status.current_song.cover_url;
        if (coverUrl !== currentPlayerBarCoverUrl) {
            currentPlayerBarCoverUrl = coverUrl;
            if (playerBarCoverObjectUrl) {
                URL.revokeObjectURL(playerBarCoverObjectUrl);
                playerBarCoverObjectUrl = null;
            }
            fetchWithAuth(coverUrl, COVER_FETCH_TIMEOUT_MS).then(blob => {
                if (coverUrl !== currentPlayerBarCoverUrl) return;
                playerBarCoverObjectUrl = URL.createObjectURL(blob);
                const img = document.getElementById('playerBarCover');
                if (img) img.src = playerBarCoverObjectUrl;
            }).catch(() => {
                if (coverUrl !== currentPlayerBarCoverUrl) return;
                const img = document.getElementById('playerBarCover');
                if (img) img.removeAttribute('src');
            });
        }
    } else if (currentPlayerBarCoverUrl) {
        currentPlayerBarCoverUrl = '';
        if (playerBarCoverObjectUrl) {
            URL.revokeObjectURL(playerBarCoverObjectUrl);
            playerBarCoverObjectUrl = null;
        }
        const img = document.getElementById('playerBarCover');
        if (img) img.removeAttribute('src');
    }

    // 通知状态监听器
    for (const fn of statusListeners) fn(status);
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
    lastVolumeInteractTime = Date.now();
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
export function loadDeviceStatus(force) {
    if (!force && lastToggleMs > 0 && (Date.now() - lastToggleMs < 2000)) return;

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
 * 应用一条推送/拉取到的设备状态到 UI。
 * 与 loadDeviceStatus 共用同一个 2s toggle 抑制窗口：刚点过播放/暂停等操作的 2s 内，
 * 忽略此次状态，避免过期数据覆盖乐观 UI。供 WebSocket 状态推送（status-stream.js）调用。
 */
export function handlePushedStatus(status) {
    if (!status) return;
    if (lastToggleMs > 0 && (Date.now() - lastToggleMs < 2000)) return;
    updatePlayerUI(status);
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
export function togglePlayModePanel(e) {
    const panel = document.getElementById('playModePanel');
    const backdrop = document.getElementById('playModeBackdrop');
    const btn = e?.currentTarget || document.getElementById('playModeBtn');

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
export function toggleVolumePanel(e) {
    const panel = document.getElementById('volumePanel');
    const backdrop = document.getElementById('volumeBackdrop');
    const btn = e?.currentTarget || document.getElementById('volumePopupBtn');

    if (!panel || !backdrop || !btn) return;

    if (panel.classList.contains('show')) {
        closeVolumePanel();
        return;
    }

    // 先关闭其他弹出层
    closeAllPopups();

    const rect = btn.getBoundingClientRect();
    const panelWidth = 56;
    let left = rect.left + rect.width / 2 - panelWidth / 2;
    if (left < 16) left = 16;
    if (left + panelWidth > window.innerWidth - 16) left = window.innerWidth - panelWidth - 16;
    panel.style.left = left + 'px';

    const isTopHalf = rect.top < window.innerHeight / 2;
    if (isTopHalf) {
        panel.style.top = (rect.bottom + 8) + 'px';
        panel.style.bottom = 'auto';
    } else {
        panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        panel.style.top = 'auto';
    }

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

// ========== 认证请求辅助 ==========

/**
 * 用插件 token 认证 fetch 资源（封面、歌词等）
 * @param {string} url - 主程序 API 路径（如 /api/v1/songs/4/cover）
 * @param {number} timeoutMs - 超时时间（毫秒），0 表示不限制
 * @returns {Promise<Blob|null>}
 */
export function fetchWithAuth(url, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    const token = getAuthToken();
    const headers = {};
    if (token) {
        headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const options = { headers };
    let timeoutId = null;
    if (controller && timeoutMs > 0) {
        options.signal = controller.signal;
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    return fetch(url, options).then(res => {
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        return res.blob();
    }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
    });
}

// ========== 歌词相关 ==========

/**
 * 获取并解析歌词
 * 经插件后端 /lyric 代理拉取：主程序对无歌词的 remote 歌曲会返回 404（设计如此，
 * 用于触发歌词插件懒搜索），直连会被浏览器记为网络错误刷控制台。插件后端把 404
 * 归一化为 200 空 payload，前端只与本插件端点通信，从而消除控制台 404 噪音。
 * @param {number|string} songId - 歌曲 ID
 */
function fetchLyrics(songId) {
    if (!songId) return;

    if (lyricFetchTimer) {
        clearTimeout(lyricFetchTimer);
        lyricFetchTimer = null;
    }

    lyricFetchTimer = setTimeout(() => {
        lyricFetchTimer = null;
        apiGet('/lyric?song_id=' + encodeURIComponent(songId)).then(data => {
            const lrcText = (data && typeof data.lyric === 'string') ? data.lyric : '';
            currentLyrics = parseLrc(lrcText);
            lastBarLyricIndex = -1; // 新歌词就绪，重置高亮索引
            if (currentLyrics.length === 0) {
                const playerBarLyric = document.getElementById('playerBarLyric');
                if (playerBarLyric) playerBarLyric.textContent = '暂无歌词';
            } else if (!isCurrentlyPlaying) {
                // 暂停态 RAF 不跑，歌词异步到达后直接同步一次
                updatePlayerBarLyric(currentPosition);
            }
        }).catch(err => {
            currentLyrics = [];
            const playerBarLyric = document.getElementById('playerBarLyric');
            if (playerBarLyric) playerBarLyric.textContent = '暂无歌词';
            console.warn('获取歌词失败:', err);
        });
    }, 500);
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
