let desmosCalc = null;
let currentSolutionMarkdown = "";
let isRegisterMode = false;

document.addEventListener("DOMContentLoaded", () => {
    initDesmos();
    initTheme();
    checkAuthStatus();
    initApiKey();
    setupEventListeners();
});

function initDesmos() {
    const elt = document.getElementById('desmosCalculator');
    if (elt) {
        desmosCalc = Desmos.GraphingCalculator(elt, { keypad: false, expressions: true, settingsMenu: false });
        desmosCalc.setExpression({ id: 'graph1', latex: 'y = \\sin(x)/x' });
    }
}

function initTheme() {
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
    document.getElementById("themeToggle").addEventListener("click", () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });
}

function initApiKey() {
    const savedKey = localStorage.getItem("gemini_api_key");
    if (savedKey) document.getElementById("apiKeyInput").value = savedKey;
}

// --- 选项A：用户中心前端状态切换控制 ---
async function checkAuthStatus() {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    const authArea = document.getElementById("userAuthArea");
    
    if (data.logged_in) {
        authArea.innerHTML = `
            <div class="flex items-center space-x-2 bg-slate-100 dark:bg-slate-700 px-3 py-1.5 rounded-xl">
                <span class="text-emerald-500">●</span>
                <span class="max-w-[80px] truncate text-xs">${data.username}</span>
                <button onclick="handleLogout()" class="text-red-400 text-xs pl-1 hover:underline">退出</button>
            </div>`;
    } else {
        authArea.innerHTML = `<button onclick="toggleAuthModal(true, false)" class="bg-blue-600 text-white px-3 py-1.5 rounded-xl text-xs font-bold hover:bg-blue-700 transition">登录 / 注册</button>`;
    }
    loadHistory(); // 重新加载隔离后的专属历史记录
}

function toggleAuthModal(show, toRegister = false) {
    const modal = document.getElementById("authModal");
    modal.classList.toggle("hidden", !show);
    isRegisterMode = toRegister;
    
    document.getElementById("modalTitle").innerText = isRegisterMode ? "新账户注册" : "用户登录";
    document.getElementById("switchAuthModeBtn").innerText = isRegisterMode ? "已有账号？去登录" : "没有账号？立即注册";
    document.getElementById("authSubmitBtn").innerText = isRegisterMode ? "立即创建账户" : "建立安全连接";
}

function switchAuthMode() {
    toggleAuthModal(true, !isRegisterMode);
}

async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    checkAuthStatus();
}

// 事件监听机制
function setupEventListeners() {
    const inputArea = document.getElementById("problemInput");
    
    // 实时方程渲染
    inputArea.addEventListener("input", () => {
        const previewElt = document.getElementById("latexPreview");
        previewElt.innerHTML = inputArea.value.replace(/\n/g, "<br>");
        if (window.MathJax) MathJax.typesetPromise([previewElt]).catch(err => console.log(err));
    });

    document.getElementById("configToggle").addEventListener("click", () => {
        document.getElementById("configPanel").classList.toggle("hidden");
    });

    document.getElementById("saveKeyBtn").addEventListener("click", () => {
        const key = document.getElementById("apiKeyInput").value.trim();
        if(key) {
            localStorage.setItem("gemini_api_key", key);
            alert("Gemini API Key 已部署！");
            document.getElementById("configPanel").classList.add("hidden");
        }
    });

    // 提交认证数据
    document.getElementById("authSubmitBtn").addEventListener("click", async () => {
        const username = document.getElementById("authUsername").value.trim();
        const password = document.getElementById("authPassword").value.trim();
        if(!username || !password) return alert("请完整填报凭证。");

        const url = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        
        if(data.error) {
            alert(data.error);
        } else {
            if(isRegisterMode) {
                alert("注册成功，请执行登录。");
                toggleAuthModal(true, false);
            } else {
                toggleAuthModal(false);
                checkAuthStatus();
            }
        }
    });

    // 随机抽题
    document.getElementById("randomPickBtn").addEventListener("click", async () => {
        const res = await fetch('/api/bank');
        const data = await res.json();
        const cats = ["limit", "derivative", "integral", "series"];
        const q = data[cats[Math.floor(Math.random()*4)]];
        inputArea.value = q[Math.floor(Math.random()*q.length)].content;
        inputArea.dispatchEvent(new Event('input'));
    });

    // 核心求解
    document.getElementById("solveBtn").addEventListener("click", async () => {
        const problem = inputArea.value.trim();
        const apiKey = localStorage.getItem("gemini_api_key");
        if(!problem) return alert("请输入数学题目。");
        if(!apiKey) return alert("请先配置您的 Gemini API 密钥！");

        const wrapper = document.getElementById("solutionWrapper");
        const content = document.getElementById("solutionContent");
        
        wrapper.classList.remove("hidden");
        content.innerHTML = `<div class="p-3 text-xs text-blue-600 animate-pulse bg-blue-50 dark:bg-blue-950/30 rounded-lg">正在加载华东师大标准全推导流程，请静候数理核验...</div>`;
        wrapper.scrollIntoView({ behavior: 'smooth' });

        try {
            const response = await fetch('/api/solve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ problem, api_key: apiKey })
            });
            const data = await response.json();
            if (data.error) { content.innerHTML = `<div class="p-3 text-xs text-red-500">${data.error}</div>`; return; }

            currentSolutionMarkdown = data.solution;
            formatAndRenderSolution(data.solution);
            parseAndDrawFunction(data.solution);

            // 存储到对应账户的历史中
            await fetch('/api/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: "rec_" + Date.now(), problem, solution: data.solution, date: new Date().toLocaleString() })
            });
            loadHistory();
        } catch (e) { content.innerHTML = `<div class="p-3 text-xs text-red-500">网络异常。</div>`; }
    });

    document.getElementById("copyLatexBtn").addEventListener("click", () => {
        navigator.clipboard.writeText(currentSolutionMarkdown);
        alert("Markdown/LaTeX 源码已复制！");
    });
    document.getElementById("printBtn").addEventListener("click", () => window.print());
}

async function loadHistory() {
    const res = await fetch('/api/history');
    const history = await res.json();
    const container = document.getElementById("historyList");
    if(history.length === 0) { container.innerHTML = `<p class="text-[11px] text-slate-400 text-center py-4">无历史存档（登录可查看专属存档）</p>`; return; }
    
    container.innerHTML = history.map(h => `
        <div class="p-2.5 bg-slate-50 dark:bg-slate-900 rounded-xl text-xs border border-slate-100 dark:border-slate-800">
            <span class="text-[10px] text-slate-400 block">${h.date}</span>
            <p class="font-mono font-bold truncate mt-0.5 text-slate-600 dark:text-slate-400">${h.problem}</p>
            <div class="mt-1.5 flex gap-2">
                <button onclick="reviewHistory('${h.id}')" class="text-[10px] text-blue-500 hover:underline">查看</button>
                <button onclick="deleteHistory('${h.id}')" class="text-[10px] text-red-400 hover:underline">删除</button>
            </div>
        </div>
    `).join('');
}

async function reviewHistory(id) {
    const res = await fetch('/api/history');
    const history = await res.json();
    const record = history.find(h => h.id === id);
    if(record) {
        document.getElementById("problemInput").value = record.problem;
        document.getElementById("solutionWrapper").classList.remove("hidden");
        currentSolutionMarkdown = record.solution;
        formatAndRenderSolution(record.solution);
        parseAndDrawFunction(record.solution);
        document.getElementById("solutionWrapper").scrollIntoView({ behavior: 'smooth' });
    }
}

async function deleteHistory(id) {
    if(confirm("确认删除该记录？")) {
        await fetch('/api/history/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        loadHistory();
    }
}

function formatAndRenderSolution(markdownText) {
    const contentElt = document.getElementById("solutionContent");
    
    // 1. 🛡️ 核心防吞步骤：首先把文本中的 < 和 > 转义，防止浏览器误认为是 HTML 标签而把公式和后续文本卡死吞掉
    let safeText = markdownText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // 2. 执行 Markdown 元素和公式格式化
    let html = safeText
        .replace(/##\s+(.+)/g, '<h3 class="text-sm font-bold text-slate-800 dark:text-slate-200 mt-4 mb-1 border-l-4 border-indigo-500 pl-2">$1</h3>')
        // ✅ 修正此处的经典笔误：将原来的 \*\" 改回标准的 \*\* 匹配
        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-indigo-600 dark:text-indigo-400">$1</strong>')
        .replace(/【易错点提示】/g, '<span class="bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 text-[10px] px-1.5 py-0.5 rounded font-bold">⚠️ 易错点</span>');
    
    contentElt.innerHTML = html;
    
    // 3. 💡 注入 Tailwind 类名确保段落换行正常显示，且绝不破坏 MathJax 数学公式
    contentElt.classList.add("whitespace-pre-wrap");

    // 4. 🧮 唤醒 MathJax 渲染标准华东师大印刷体公式
    if (window.MathJax) {
        MathJax.typesetPromise([contentElt]).catch(err => console.log(err));
    }
}
function parseAndDrawFunction(markdownText) {
    if (!desmosCalc) return;

    // 1. 🧹 每次出新题时，先清空上一次画的图，防止旧图残留
    desmosCalc.setBlank();

    // 2. 🔍 提取出所有被 $$ 或 $ 包裹的 LaTeX 公式
    const formulaRegex = /\$\$([\s\S]*?)\$\$|\$([\s\S]*?)\$/g;
    let match;
    let targetExpression = null;

    while ((match = formulaRegex.exec(markdownText)) !== null) {
        let formula = (match[1] || match[2] || "").trim();
        if (!formula) continue;

        // 清理掉 LaTeX 常见的空格微调符号，方便 Desmos 识别
        formula = formula.replace(/\\,/g, '').replace(/\\ /g, '').replace(/\\!/g, '');

        // 3. 🎯 核心判定：寻找符合画图特征的公式
        // 比如含有 y=, f(x)=，或者直接是含 x 的可解析表达式
        if (formula.startsWith('y=') || formula.startsWith('f(x)=')) {
            targetExpression = formula;
            break; // 优先抓取显函数方程
        } else if (formula.includes('x') && !formula.includes('\\lim') && !formula.includes('\\int') && formula.length < 30) {
            // 如果没有 y=，但单纯是个含 x 的简短表达式（如 x^2 + 2x），帮它补上 y =
            if (!formula.includes('=')) {
                targetExpression = 'y=' + formula;
            }
        }
    }

    // 4. 🎨 如果抓到了函数，立刻在 Desmos 上绘制出来
    if (targetExpression) {
        try {
            desmosCalc.setExpression({
                id: 'ai_dynamic_function',
                latex: targetExpression,
                color: '#6366f1' // 使用跟你网页配套的靛蓝色
            });
            console.log("Desmos 成功动态绘制函数:", targetExpression);
        } catch (e) {
            console.log("Desmos 绘图解析失败:", e);
        }
    } else {
        // 兜底方案：如果这道题实在是纯数字计算（没函数图形），就展示一个优雅的极坐标网格或留空
        desmosCalc.setExpression({ id: 'origin', latex: '(0,0)', label: '原点', showLabel: true });
    }
}
