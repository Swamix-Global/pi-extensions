"""Deterministic whole-file structural maps: contiguous declaration sections with concise names and purposes.

Names and line ranges are always retained; purpose words adapt toward a soft
per-file density target, and unsupported syntax honestly falls back to blocks.
"""
import ast
import os
import re

MAP_STRUCTURAL = "structural"
MAP_FALLBACK = "fallback"

_PYTHON_EXTENSIONS = {".py", ".pyw"}

# Go and Rust use distinct grammars; C-family lexing would misread their functions,
# so they intentionally fall through to honest fallback blocks.
_C_EXTENSIONS = {
    ".c", ".h", ".cc", ".hh", ".cpp", ".hpp", ".cxx", ".hxx", ".ino", ".m", ".mm",
    ".cs", ".java", ".kt", ".kts", ".scala", ".groovy", ".swift", ".dart",
    ".zig", ".nim", ".v",
}

# Adaptive map density: purpose words trend toward MAP_WORD_TARGET per file while
# every section keeps its name/range and at least PURPOSE_MIN_WORDS purpose words.
MAP_WORD_TARGET = 100
SECTION_NAME_WORDS = 14
PURPOSE_MIN_WORDS = 3
PURPOSE_MAX_WORDS = 16
_JS_EXTENSIONS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".svelte", ".vue", ".astro"}
_SHELL_EXTENSIONS = {".sh", ".bash", ".zsh", ".ksh", ".dash", ".csh", ".tcsh", ".fish", ".nu"}
_SHELL_INTERPRETERS = {"sh", "bash", "zsh", "ksh", "dash", "csh", "tcsh", "fish", "nu"}
_BATCH_EXTENSIONS = {".bat", ".cmd"}
_MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdown"}
_MARKDOWN_NAMES = {"readme.md", "agents.md", "claude.md", "contributing.md", "architecture.md"}


def _lines(content):
    """Split content into physical lines without a phantom line after a trailing newline."""
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _shebang_kind(first):
    """Classify a lowercase ``#!`` line by interpreter token, unwrapping ``env`` forms."""
    tokens = [token for token in re.split(r"[\s/]+", first[2:]) if token]
    if any(token.startswith("python") for token in tokens):
        return "python"
    if any(token.startswith("node") for token in tokens):
        return "js"
    return "shell" if _SHELL_INTERPRETERS.intersection(tokens) else None


def _kind(path, content):
    """Classify a source path by suffix, curated Markdown name or interpreter shebang."""
    name = os.path.basename(path).lower()
    extension = os.path.splitext(name)[1]
    if extension in _PYTHON_EXTENSIONS:
        return "python"
    if extension in _C_EXTENSIONS:
        return "c"
    if extension in _JS_EXTENSIONS:
        return "js"
    if extension in _SHELL_EXTENSIONS:
        return "shell"
    if extension in _BATCH_EXTENSIONS:
        return "batch"
    if extension in _MARKDOWN_EXTENSIONS or name in _MARKDOWN_NAMES:
        return "markdown"
    if not extension:
        first = content.split("\n", 1)[0].lower()
        if first.startswith("#!"):
            return _shebang_kind(first)
    return None


def _intent_words(name):
    """Humanize an identifier into lowercase words for a compact purpose phrase."""
    words = re.sub(r"[^A-Za-z0-9]+", " ", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name or "")).split()
    unique = [word for position, word in enumerate(words) if position == 0 or word != words[position - 1]]
    return " ".join(unique).lower()


def _shorten(text, limit=12):
    """Collapse whitespace and keep at most ``limit`` words so purposes stay compact."""
    return " ".join((text or "").split()[:limit])


_COMMENT_CLEAN = "*/#: \t"
_CODE_LIKE = re.compile(r"[{};=]|[A-Za-z_]\w*\s*\(")


def _comment_purpose(lines, index, pattern):
    """Return capped purpose text from the immediately preceding comment line, or None."""
    if index <= 0:
        return None
    previous = lines[index - 1].strip()
    match = pattern.match(previous)
    if not match:
        return None
    text = previous[match.end():]
    if text.endswith("*/"):
        text = text[:-2]
    text = text.strip(_COMMENT_CLEAN)
    if not any(character.isalnum() for character in text):
        return None
    if _CODE_LIKE.search(text):
        return None
    return _shorten(text) or None


_RAW_STRING = re.compile(r'(?:u8|u|U|L)?R"([^()\\ \t]{0,16})\(')


def _mask(lines, line_comment=None, block_comment=False, template=False, raw_strings=False):
    """Replace comments and string bodies with spaces while preserving every character position and line."""
    masked = []
    in_block = False
    in_template = False
    raw_close = None
    for line in lines:
        chars = []
        index = 0
        while index < len(line):
            if raw_close is not None:
                end = line.find(raw_close, index)
                if end < 0:
                    chars.append(" " * (len(line) - index))
                    index = len(line)
                else:
                    chars.append(" " * (end + len(raw_close) - index))
                    index = end + len(raw_close)
                    raw_close = None
                continue
            if in_block:
                end = line.find("*/", index)
                if end < 0:
                    chars.append(" " * (len(line) - index))
                    index = len(line)
                else:
                    chars.append(" " * (end + 2 - index))
                    index = end + 2
                    in_block = False
                continue
            if in_template:
                end = index
                while end < len(line):
                    if line[end] == "\\":
                        end += 2
                    elif line[end] == "`":
                        break
                    else:
                        end += 1
                stop = min(end, len(line))
                chars.append(" " * (stop - index))
                index = stop
                if index < len(line):
                    chars.append("`")
                    index += 1
                    in_template = False
                continue
            if block_comment and line.startswith("/*", index):
                end = line.find("*/", index + 2)
                if end < 0:
                    chars.append(" " * (len(line) - index))
                    index = len(line)
                    in_block = True
                else:
                    chars.append(" " * (end + 2 - index))
                    index = end + 2
                continue
            if line_comment and line.startswith(line_comment, index):
                chars.append(" " * (len(line) - index))
                index = len(line)
                continue
            if raw_strings:
                raw = _RAW_STRING.match(line, index)
                if raw:
                    chars.append(" " * (raw.end() - index))
                    raw_close = ")" + raw.group(1) + '"'
                    index = raw.end()
                    continue
            character = line[index]
            if character in "\"'":
                chars.append(character)
                index += 1
                while index < len(line):
                    if line[index] == "\\" and index + 1 < len(line):
                        chars.append("  ")
                        index += 2
                    elif line[index] == character:
                        chars.append(character)
                        index += 1
                        break
                    else:
                        chars.append(" ")
                        index += 1
                continue
            if template and character == "`":
                chars.append("`")
                index += 1
                in_template = True
                continue
            chars.append(character)
            index += 1
        masked.append("".join(chars))
    return masked


def _assigned_name(node):
    """Return a simple assignment target name when the left side is a plain identifier."""
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        return node.targets[0].id
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return node.target.id
    return None


def _is_entry_guard(node):
    """Detect the common ``if __name__ == \"__main__\":`` script guard."""
    test = node.test
    return isinstance(test, ast.Compare) and isinstance(test.left, ast.Name) and test.left.id == "__name__" and any(
        isinstance(item, ast.Constant) and item.value == "__main__" for item in test.comparators)


_SENTENCE = re.compile(r"[^.!?]*[.!?]")


def _docstring_purpose(node):
    """Return a purpose from the first docstring sentence, else readable identifier words."""
    docstring = ast.get_docstring(node, clean=True)
    if docstring:
        collapsed = " ".join(docstring.split())
        match = _SENTENCE.match(collapsed)
        purpose = _shorten((match.group(0) if match else collapsed).rstrip(".!?"))
        if purpose:
            return purpose
    return _intent_words(node.name) or "declaration"


def _python_starts(content):
    """Collect AST declaration starts, or None when Python cannot parse the content."""
    try:
        tree = ast.parse(content)
    except (SyntaxError, ValueError):
        return None
    starts = []
    body = tree.body
    index = 0
    while index < len(body):
        node = body[index]
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            modules = []
            while index < len(body) and isinstance(body[index], (ast.Import, ast.ImportFrom)):
                for alias in body[index].names:
                    root = alias.name.split(".")[0]
                    if root not in modules:
                        modules.append(root)
                index += 1
            starts.append((node.lineno, "imports", "imports " + ", ".join(modules[:4])))
            continue
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = []
            while index < len(body) and isinstance(body[index], (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets.append(_assigned_name(body[index]))
                index += 1
            if len(targets) == 1 and targets[0]:
                starts.append((node.lineno, targets[0], "module constant"))
            else:
                starts.append((node.lineno, "configuration", f"{len(targets)} module assignments"))
            continue
        if isinstance(node, ast.If) and _is_entry_guard(node):
            starts.append((node.lineno, "entrypoint", "script entrypoint"))
        index += 1
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            line = min([node.lineno] + [item.lineno for item in getattr(node, "decorator_list", [])])
            starts.append((line, node.name, _docstring_purpose(node)))
    return starts


_C_CONTROL = frozenset("if for while switch catch return else do case sizeof goto throw new delete "
                       "co_await co_return co_yield".split())
_C_INCLUDE = re.compile(r"^\s*#\s*include\b")
_C_DEFINE = re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)")
_C_OTHER_DIRECTIVE = re.compile(r"^\s*#")
_C_NAMESPACE = re.compile(r"^\s*(?:inline\s+)?namespace\s+([A-Za-z_]\w*)")
_C_TYPE = re.compile(r"^\s*(class|struct|enum(?:\s+class)?|union)\s+([A-Za-z_]\w*)")
_C_HEAD = re.compile(
    r"^\s*(?:(?P<ret>[\w:<>,\*&~\[\]]+(?:\s+[\w:<>,\*&~\[\]]+)*)\s+)?"
    r"(?P<name>~?[A-Za-z_]\w*(?:::[A-Za-z_~]\w*)*|operator\s*\(\)|operator\s*[^\s(]+)"
    r"\s*\((?P<params>.*)$")
_C_TAIL_OK = ("{", ":", "->", "=", "&", ";")
_C_QUALIFIERS = re.compile(r"\b(?:const|noexcept(?:\([^)]*\))?|override|final)\b")
_C_HEAD_LINES = 6
_C_SIGNATURE_LINES = 40
_C_COMMENT = re.compile(r"//|/\*")


def _c_function(masked, index, total):
    """Parse a possibly multi-line declaration head, rejecting calls and plain statements."""
    if not masked[index].strip() or masked[index].split()[0] in _C_CONTROL:
        return None
    joined = masked[index]
    last = index
    while "(" not in joined:
        if last + 1 >= total or last - index >= _C_HEAD_LINES:
            return None
        last += 1
        joined += " " + masked[last].strip()
        if "(" not in joined and any(character in joined for character in ";{}:="):
            return None
    match = _C_HEAD.match(joined)
    if not match:
        return None
    params = match.group("params")
    balance = params.count("(") - params.count(")")
    while (balance > 0 or ")" not in params) and last + 1 < total and last - index < _C_SIGNATURE_LINES:
        last += 1
        params += " " + masked[last].strip()
        balance += masked[last].count("(") - masked[last].count(")")
    if balance > 0:
        return None
    tail = _C_QUALIFIERS.sub("", params[params.rfind(")") + 1:]).strip()
    name = re.sub(r"\s+", " ", match.group("name"))
    parts = [part.lstrip("~") for part in name.split("::")]
    constructor = len(parts) > 1 and parts[-1] == parts[-2]
    if tail and not tail.startswith(_C_TAIL_OK):
        return None
    if tail.startswith(";") and not match.group("ret") and not constructor:
        return None
    return name, last


def _c_starts(lines):
    """Lexically collect includes, macros and declarations from masked C-family source."""
    masked = _mask(lines, line_comment="//", block_comment=True, raw_strings=True)
    starts = []
    index = 0
    total = len(masked)
    continuing = False
    while index < total:
        line = masked[index]
        if continuing:
            continuing = line.rstrip().endswith("\\")
            index += 1
            continue
        if _C_INCLUDE.match(line):
            end = index
            while end < total and _C_INCLUDE.match(masked[end]):
                end += 1
                if masked[end - 1].rstrip().endswith("\\"):
                    break
            continuing = masked[end - 1].rstrip().endswith("\\")
            starts.append((index + 1, "includes", f"{end - index} include directives"))
            index = end
            continue
        if _C_DEFINE.match(line):
            names = []
            end = index
            while end < total and _C_DEFINE.match(masked[end]):
                names.append(_C_DEFINE.match(masked[end]).group(1))
                if masked[end].rstrip().endswith("\\"):
                    end += 1
                    break
                end += 1
            continuing = masked[end - 1].rstrip().endswith("\\")
            purpose = _comment_purpose(lines, index, _C_COMMENT) or "macro"
            starts.append((index + 1, names[0] if len(names) == 1 else "defines",
                           purpose if len(names) == 1 else f"{len(names)} macros"))
            index = end
            continue
        if _C_OTHER_DIRECTIVE.match(line):
            continuing = line.rstrip().endswith("\\")
            index += 1
            continue
        match = _C_NAMESPACE.match(line)
        if match:
            starts.append((index + 1, match.group(1),
                           _comment_purpose(lines, index, _C_COMMENT) or "namespace"))
            index += 1
            continue
        match = _C_TYPE.match(line)
        if match:
            starts.append((index + 1, match.group(2),
                           _comment_purpose(lines, index, _C_COMMENT) or match.group(1).split()[0]))
            index += 1
            continue
        function = _c_function(masked, index, total)
        if function:
            name, last = function
            starts.append((index + 1, name,
                           _comment_purpose(lines, index, _C_COMMENT) or _intent_words(name) or "declaration"))
            index = last + 1
            continue
        index += 1
    return starts


_JS_CONTROL = re.compile(r"^\s*(?:if|for|while|switch|catch|return|else|do|case|throw|new|delete|typeof|yield|await|with)\b")
_JS_CLASS = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)")
_JS_FUNC = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?")
_JS_TYPE = re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)")
_JS_BINDING = re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)")
_JS_METHOD = re.compile(
    r"^\s*(?:(?:public|private|protected|static|async|get|set|readonly|override)\s+|\*\s*)*"
    r"([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?::\s*[\w<>\[\]|,.\s]+)?\{")


def _js_starts(lines):
    """Lexically collect JS/TS declarations and grouped module bindings from masked source."""
    masked = _mask(lines, line_comment="//", block_comment=True, template=True)
    starts = []
    index = 0
    total = len(masked)
    while index < total:
        line = masked[index]
        match = _JS_CLASS.match(line)
        if match:
            starts.append((index + 1, match.group(1), "class"))
            index += 1
            continue
        match = _JS_FUNC.match(line)
        if match:
            starts.append((index + 1, match.group(1) or "default export", "function"))
            index += 1
            continue
        match = _JS_TYPE.match(line)
        if match:
            starts.append((index + 1, match.group(2), match.group(1)))
            index += 1
            continue
        match = _JS_METHOD.match(line)
        if match and not _JS_CONTROL.match(line):
            starts.append((index + 1, match.group(1), "method"))
            index += 1
            continue
        match = _JS_BINDING.match(line)
        if match and not _JS_CONTROL.match(line):
            if "=>" in line or re.search(r"=\s*(?:async\s*)?function\b", line):
                starts.append((index + 1, match.group(1), "function"))
                index += 1
                continue
            end = index
            names = []
            while end < total:
                binding = _JS_BINDING.match(masked[end])
                if not binding or "=>" in masked[end] or re.search(r"=\s*(?:async\s*)?function\b", masked[end]):
                    break
                names.append(binding.group(1))
                end += 1
            starts.append((index + 1, names[0] if len(names) == 1 else "bindings",
                           "module binding" if len(names) == 1 else f"{len(names)} module bindings"))
            index = end
            continue
        index += 1
    return starts


_SHELL_CONTROL = frozenset("if for while until case select then do else elif fi done esac in function time".split())
_SHELL_ASSIGN = re.compile(r"^\s*([A-Za-z_]\w*)=")
_SHELL_FUNC = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w.-]*)\s*(?:\(\s*\))?\s*\{")
_SHELL_HEAD = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w.-]*)\s*(?:\(\s*\))?\s*$")
_SHELL_BLOCK = re.compile(r"^(if|for|while|until|case|select)\b")
_SHELL_HEREDOC = re.compile(r"<<(-?)\s*(?:'([^']*)'|\"([^\"]*)\"|\\?([A-Za-z_][A-Za-z0-9_-]*))")
_SHELL_COMMENT = re.compile(r"#")
_SHELL_BLOCK_PURPOSES = {
    "if": "conditional block", "for": "loop block", "while": "loop block",
    "until": "loop block", "case": "case block", "select": "select block",
}


def _shell_heredocs(line, masked):
    """Collect heredoc delimiters opened in shell code, skipping comments, strings and arithmetic shifts."""
    delimiters = []
    for match in _SHELL_HEREDOC.finditer(line):
        if masked[match.start():match.start() + 2] != "<<":
            continue
        if line[:match.start()].count("$((") > line[:match.start()].count("))"):
            continue
        delimiters.append((match.group(2) or match.group(3) or match.group(4), match.group(1) == "-"))
    return delimiters


def _shell_heredoc_lines(lines):
    """Return 1-based line numbers inside heredoc bodies so their text never yields fake functions."""
    ignored = set()
    pending = []
    for number, line in enumerate(lines, 1):
        if pending:
            ignored.add(number)
            delimiter, strip_tabs = pending[0]
            candidate = line.lstrip("\t") if strip_tabs else line
            if candidate.strip() == delimiter:
                pending.pop(0)
            continue
        pending.extend(_shell_heredocs(line, _mask([line], line_comment="#")[0]))
    return ignored


def _shell_starts(lines):
    """Lexically collect top-level shell functions, blocks and configuration variables."""
    masked = _mask(lines, line_comment="#")
    ignored = _shell_heredoc_lines(lines)
    starts = []
    index = 0
    total = len(masked)
    while index < total:
        line = masked[index]
        if index + 1 in ignored:
            index += 1
            continue
        if line[:1] not in (" ", "\t"):
            assignment = _SHELL_ASSIGN.match(line)
            if assignment:
                end = index
                names = []
                while end < total and end + 1 not in ignored and masked[end][:1] not in (" ", "\t") \
                        and _SHELL_ASSIGN.match(masked[end]):
                    names.append(_SHELL_ASSIGN.match(masked[end]).group(1))
                    end += 1
                purpose = _comment_purpose(lines, index, _SHELL_COMMENT) or \
                    ("variable" if len(names) == 1 else f"{len(names)} variables")
                starts.append((index + 1, names[0] if len(names) == 1 else "configuration", purpose))
                index = end
                continue
            block = _SHELL_BLOCK.match(line)
            if block:
                starts.append((index + 1, block.group(1),
                               _comment_purpose(lines, index, _SHELL_COMMENT) or _SHELL_BLOCK_PURPOSES[block.group(1)]))
        function = _SHELL_FUNC.match(line)
        end = index
        if function is None:
            head = _SHELL_HEAD.match(line)
            if head and head.group(1) not in _SHELL_CONTROL:
                cursor = index + 1
                while cursor < total and (cursor + 1 in ignored or not masked[cursor].strip()):
                    cursor += 1
                if cursor < total and cursor + 1 not in ignored and masked[cursor].lstrip().startswith("{"):
                    function = head
                    end = cursor
        if function and function.group(1) not in _SHELL_CONTROL:
            starts.append((index + 1, function.group(1),
                           _comment_purpose(lines, index, _SHELL_COMMENT) or _intent_words(function.group(1))
                           or "function"))
            index = end + 1
            continue
        index += 1
    return starts


_BATCH_COMMENT = re.compile(r"^\s*(?:rem\b|::)", re.IGNORECASE)
_BATCH_LABEL = re.compile(r"^\s*:([A-Za-z_][\w.-]*)")
_BATCH_SET = re.compile(r"^\s*set\s+\"?([A-Za-z_]\w*)=", re.IGNORECASE)
_BATCH_COMMENT_LINE = re.compile(r"(?i)(?:rem\b|::)")


def _batch_starts(lines):
    """Collect batch labels and grouped set configuration lines with short comment purposes."""
    starts = []
    index = 0
    total = len(lines)
    while index < total:
        line = lines[index]
        if _BATCH_COMMENT.match(line):
            index += 1
            continue
        label = _BATCH_LABEL.match(line)
        if label:
            starts.append((index + 1, label.group(1),
                           _comment_purpose(lines, index, _BATCH_COMMENT_LINE) or "label"))
            index += 1
            continue
        if _BATCH_SET.match(line):
            end = index
            names = []
            while end < total and _BATCH_SET.match(lines[end]) and not _BATCH_COMMENT.match(lines[end]):
                names.append(_BATCH_SET.match(lines[end]).group(1))
                end += 1
            purpose = _comment_purpose(lines, index, _BATCH_COMMENT_LINE) or \
                ("variable" if len(names) == 1 else f"{len(names)} variables")
            starts.append((index + 1, names[0] if len(names) == 1 else "configuration", purpose))
            index = end
            continue
        index += 1
    return starts


_MD_ATX = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_MD_SETEXT = re.compile(r"^(=+|-+)\s*$")
_MD_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
_MD_COMMENT = re.compile(r"^\s*<!--")
_MD_NAME_WORDS = 10
_MD_PURPOSE_WORDS = 8


def _md_text(text):
    """Strip inline Markdown links and emphasis so heading names stay short and readable."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[*_`~]+", "", text).strip()


def _heading(number, text, level):
    """Return a heading start tuple with a capped topic name and topic-first purpose."""
    topic = _md_text(text)
    purpose = f"level {level} heading"
    if topic:
        purpose += ": " + _shorten(topic, _MD_PURPOSE_WORDS)
    return number, _shorten(topic, _MD_NAME_WORDS) or "heading", purpose


def _markdown_starts(lines):
    """Collect heading starts outside fenced code blocks and HTML comments."""
    starts = []
    fence = None
    comment = False
    for number, line in enumerate(lines, 1):
        if comment:
            if "-->" in line:
                comment = False
            continue
        match = _MD_FENCE.match(line)
        if fence is not None:
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= fence[1]:
                fence = None
            continue
        if match:
            fence = (match.group(1)[0], len(match.group(1)))
            continue
        if _MD_COMMENT.match(line):
            if "-->" not in line:
                comment = True
            continue
        match = _MD_ATX.match(line)
        if match:
            starts.append(_heading(number, match.group(2), len(match.group(1))))
            continue
        if _MD_SETEXT.match(line) and number > 1:
            previous = lines[number - 2].strip()
            if previous and not _MD_ATX.match(lines[number - 2]):
                starts.append(_heading(number - 1, previous, 1 if line.startswith("=") else 2))
    return starts


def _build(starts, total):
    """Turn declaration starts into contiguous sections covering every physical line.

    Every section keeps its name and line range; purpose words adapt toward
    MAP_WORD_TARGET total map words and never drop below three words.
    """
    if total <= 0:
        return []
    unique = []
    seen = set()
    for line, name, purpose in sorted(starts, key=lambda item: (item[0], item[1])):
        if line in seen:
            continue
        seen.add(line)
        unique.append((max(1, min(line, total)), name, purpose))
    spans = []
    if not unique or unique[0][0] > 1:
        spans.append((1, unique[0][0] - 1 if unique else total, "preamble", "leading comments and setup"))
    for position, (line, name, purpose) in enumerate(unique):
        end = unique[position + 1][0] - 1 if position + 1 < len(unique) else total
        spans.append((line, max(line, end), _shorten(name, SECTION_NAME_WORDS) or "section", purpose))
    fixed = sum(len(name.split()) for _, _, name, _ in spans)
    allowance = max(PURPOSE_MIN_WORDS, min(PURPOSE_MAX_WORDS, (MAP_WORD_TARGET - fixed) // len(spans)))
    return [{"line": line, "endLine": end, "name": name, "purpose": _shorten(purpose, allowance) or "declaration"}
            for line, end, name, purpose in spans]


def _fallback(lines):
    """Generic blank-line blocks for unsupported or unparsable syntax, honestly marked fallback."""
    starts = []
    for number, line in enumerate(lines, 1):
        previous = lines[number - 2] if number > 1 else ""
        if line.strip() and not previous.strip():
            starts.append((number, f"block {len(starts) + 1}", "source block"))
    return _build(starts, len(lines)), MAP_FALLBACK


def _structural(lines, starts):
    """Build structural sections, or honest fallback blocks when no declaration was detected."""
    return (_build(starts, len(lines)), MAP_STRUCTURAL) if starts else _fallback(lines)


def sections_for(path, content):
    """Return (sections, map_kind): ordered {line,endLine,name,purpose} sections covering every physical line."""
    if not isinstance(content, str):
        raise TypeError("content must be a string")
    lines = _lines(content)
    kind = _kind(path, content)
    if kind == "python":
        starts = _python_starts(content)
        return _fallback(lines) if starts is None else _structural(lines, starts)
    if kind == "c":
        return _structural(lines, _c_starts(lines))
    if kind == "js":
        return _structural(lines, _js_starts(lines))
    if kind == "shell":
        return _structural(lines, _shell_starts(lines))
    if kind == "batch":
        return _structural(lines, _batch_starts(lines))
    if kind == "markdown":
        return _structural(lines, _markdown_starts(lines))
    return _fallback(lines)
