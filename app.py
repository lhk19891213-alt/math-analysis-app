import os
import json
import uuid
from flask import Flask, render_template, request, jsonify, session
from PIL import Image
import google.generativeai as genai
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.urandom(24)

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
BANK_FILE = os.path.join(DATA_DIR, 'bank.json')
HISTORY_FILE = os.path.join(DATA_DIR, 'history.json')
USERS_FILE = os.path.join(DATA_DIR, 'users.json')

os.makedirs(DATA_DIR, exist_ok=True)

def init_files():
    if not os.path.exists(BANK_FILE):
        categories = ["limit", "derivative", "integral", "series"]
        bank_data = {cat: [{
            "id": f"{cat}_{i}",
            "title": f"经典{cat}例题 {i}",
            "content": f"求以下数学分析题目的解：\\lim_{{x \\to 0}} \\frac{{\\sin x - x}}{{x^3}}" if cat=="limit" else "\\int_{0}^{\\pi} \\sin^2 x \\, dx",
            "category": cat
        } for i in range(1, 6)] for cat in categories}
        with open(BANK_FILE, 'w', encoding='utf-8') as f:
            json.dump(bank_data, f, ensure_ascii=False, indent=4)
    if not os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
            json.dump([], f, ensure_ascii=False, indent=4)
    if not os.path.exists(USERS_FILE):
        with open(USERS_FILE, 'w', encoding='utf-8') as f:
            json.dump({}, f, ensure_ascii=False, indent=4)

init_files()

def get_clean_api_key(frontend_key):
    """清洗前端传来的无效密钥，强制转换为 Render 后台的环境变量"""
    if not frontend_key:
        return os.environ.get('GEMINI_API_KEY')
    key_str = str(frontend_key).strip()
    if key_str.lower() in ['', 'null', 'undefined', 'none']:
        return os.environ.get('GEMINI_API_KEY')
    return key_str

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    if not username or not password:
        return jsonify({"error": "账号或密码不能为空"}), 400
    with open(USERS_FILE, 'r', encoding='utf-8') as f:
        users = json.load(f)
    if username in users:
        return jsonify({"error": "该用户名已被注册"}), 400
    user_id = str(uuid.uuid4())[:8]
    users[username] = {"id": user_id, "password": generate_password_hash(password)}
    with open(USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(users, f, ensure_ascii=False, indent=4)
    return jsonify({"status": "success", "message": "注册成功"})

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    with open(USERS_FILE, 'r', encoding='utf-8') as f:
        users = json.load(f)
    user = users.get(username)
    if not user or not check_password_hash(user['password'], password):
        return jsonify({"error": "用户名或密码错误"}), 401
    session['user_id'] = user['id']
    session['username'] = username
    return jsonify({"status": "success", "username": username})

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"status": "success"})

@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    if 'user_id' in session:
        return jsonify({"logged_in": True, "username": session['username']})
    return jsonify({"logged_in": False})

@app.route('/api/bank', methods=['GET'])
def get_bank():
    with open(BANK_FILE, 'r', encoding='utf-8') as f:
        return jsonify(json.load(f))

@app.route('/api/history', methods=['GET'])
def get_history():
    user_id = session.get('user_id')
    with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
        history = json.load(f)
    if user_id:
        return jsonify([r for r in history if r.get('user_id') == user_id])
    return jsonify([r for r in history if not r.get('user_id')])

@app.route('/api/history', methods=['POST'])
def save_history():
    record = request.json
    record['user_id'] = session.get('user_id')
    with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
        history = json.load(f)
    history.insert(0, record)
    with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=4)
    return jsonify({"status": "success"})

@app.route('/api/history/delete', methods=['POST'])
def delete_history():
    record_id = request.json.get('id')
    user_id = session.get('user_id')
    with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
        history = json.load(f)
    history = [r for r in history if not (r.get('id') == record_id and r.get('user_id') == user_id)]
    with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=4)
    return jsonify({"status": "success"})

@app.route('/api/solve', methods=['POST'])
def solve_problem():
    try:
        data = request.json or {}
        problem_text = data.get('problem')
        
        # 🛡️ 完美的密钥清洗流
        api_key = get_clean_api_key(data.get('api_key'))

        if not problem_text:
            return jsonify({"error": "题目内容不能为空"}), 400
        if not api_key:
            return jsonify({"error": "未检测到 Gemini API 密钥，请先配置。"}), 400

        system_instruction = (
            "你是一个极其严谨的中国大学数学分析教授，解题风格严格遵循华东师范大学《数学分析》教材规范。对输入题目进行标准化分步解答。"
            "请对用户输入的数学题目进行标准化分步解答。输出格式必须为清晰的 Markdown 文本，数学公式必须使用标准的 LaTeX 格式包裹（行内公式用 $...$，独立公式用 $$...$$）。\n"
            "输出结构必须严格包含以下几个板块（使用二级标题 ##）：\n"
            "## 1. 题型判定\n## 2. 核心定理与工具\n## 3. 严谨分步推导\n## 4. 最终答案\n## 5. 思路总结\n"
            "【特别注意】：如果该题目涉及具体的函数图像（如求导、积分、极限对应的函数），请务必在解答的『## 3. 严谨分步推导』或『## 4. 最终答案』中，用独立整行公式输出一次该函数的基本方程，例如：$$y = x^2 - 2x$$ 或 $$y = \\sin(x)/x$$，以便前端抓取画图。\n"
        )

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(
            model_name="gemini-2.5-flash",
            generation_config={"temperature": 0.1, "max_output_tokens": 4096}
        )
        response = model.generate_content(f"{system_instruction}\n\n【待解题目如下】：\n{problem_text}")
        return jsonify({"solution": response.text})
   # 修改后：把这一段替换上去
except Exception as e:
    err_msg = str(e)
    # 如果检测到 429 或者 quota 关键词，说明是被限流了
    if "429" in err_msg or "quota" in err_msg.lower():
        return jsonify({"error": "☕ 核心数理服务器正忙（触发 API 频率限制），请等待 1 分钟后再次点击生成。"}), 429
    
    # 其他未知错误才显示原样
    return jsonify({"error": f"调用 Gemini API 失败: {err_msg}"}), 500

@app.route('/api/ocr', methods=['POST'])
def upload_ocr():
    try:
        if 'image' not in request.files:
            return jsonify({"error": "没有上传图片"}), 400
        file = request.files['image']
        if file.filename == '':
            return jsonify({"error": "未选择图片"}), 400

        api_key = get_clean_api_key(request.form.get('api_key'))
        if not api_key:
            return jsonify({"error": "未检测到 Gemini API 密钥，请先在网页或后台配置。"}), 400

        genai.configure(api_key=api_key)
        img = Image.open(file.stream)
        model = genai.GenerativeModel(model_name="gemini-2.5-flash")
        prompt = "请精准识别出这张数学题目图片中的文字和 LaTeX 公式。请只返回识别后的题目纯文本内容，不要包含任何多余的寒暄、解释、Markdown标记或代码块包裹。"
        
        response = model.generate_content([prompt, img])
        return jsonify({"text": response.text.strip()})
    except Exception as e:
        return jsonify({"error": f"图片识别失败: {str(e)}"}), 500

@app.route('/')
def index():
    return render_template('index.html')

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=True)
