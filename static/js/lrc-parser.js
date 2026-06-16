/**
 * LRC 歌词解析器
 * 解析 LRC 格式歌词为时间轴数组，支持同步高亮显示
 */

/** @typedef {{ time: number; text: string }} LyricLine */

/**
 * 解析 LRC 格式歌词
 * @param {string} lrcText - LRC 格式歌词文本
 * @returns {LyricLine[]} 解析后的歌词行
 */
export function parseLrc(lrcText) {
    if (!lrcText) return [];

    const lines = lrcText.split('\n');
    const lyrics = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

    for (const line of lines) {
        if (!line.trim()) continue;

        timeRegex.lastIndex = 0;
        const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();

        if (!text) continue;

        // 循环提取所有时间标签，为每个时间生成独立歌词条目
        let match;
        while ((match = timeRegex.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const millis = match[3].length === 3
                ? parseInt(match[3], 10)
                : parseInt(match[3] + '0'.repeat(3 - match[3].length), 10);
            const time = minutes * 60 + seconds + millis / 1000;

            lyrics.push({ time, text });
        }
    }

    // 按时间排序
    lyrics.sort((a, b) => a.time - b.time);
    return lyrics;
}

/**
 * 获取当前播放进度对应的歌词行索引
 * @param {LyricLine[]} lyrics - 歌词数组
 * @param {number} position - 当前播放位置（秒）
 * @returns {number} 当前歌词行索引，-1 表示无匹配
 */
export function getCurrentLyricIndex(lyrics, position) {
    if (!lyrics || lyrics.length === 0 || position < 0) return -1;

    let currentIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        if (position >= lyrics[i].time) {
            currentIndex = i;
        } else {
            break;
        }
    }
    return currentIndex;
}

/**
 * 获取歌词行对应的秒数
 * @param {LyricLine[]} lyrics - 歌词数组
 * @param {number} index - 歌词行索引
 * @returns {number} 秒数
 */
export function getLyricTime(lyrics, index) {
    if (!lyrics || index < 0 || index >= lyrics.length) return 0;
    return lyrics[index].time;
}

/**
 * 获取歌词文本
 * @param {LyricLine[]} lyrics - 歌词数组
 * @param {number} index - 歌词行索引
 * @returns {string} 歌词文本
 */
export function getLyricText(lyrics, index) {
    if (!lyrics || index < 0 || index >= lyrics.length) return '';
    return lyrics[index].text;
}
