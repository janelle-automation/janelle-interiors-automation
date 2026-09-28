"""Builds 'How to join our Slack' — a picture-led guide for non-technical clients."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Flowable,
    KeepTogether, PageBreak, Table, TableStyle,
)
from reportlab.lib.styles import ParagraphStyle
import sys

OUT = sys.argv[1]
WORKSPACE = "Janelle Interiors"

F = "C:/Windows/Fonts/"
pdfmetrics.registerFont(TTFont("UI", F + "segoeui.ttf"))
pdfmetrics.registerFont(TTFont("UI-B", F + "segoeuib.ttf"))
pdfmetrics.registerFont(TTFont("UI-SB", F + "seguisb.ttf"))
pdfmetrics.registerFont(TTFont("UI-L", F + "segoeuil.ttf"))
pdfmetrics.registerFont(TTFont("UI-I", F + "segoeuii.ttf"))
pdfmetrics.registerFont(TTFont("UI-BI", F + "segoeuiz.ttf"))
from reportlab.lib.fonts import addMapping
addMapping("UI", 0, 0, "UI"); addMapping("UI", 1, 0, "UI-B"); addMapping("UI", 0, 1, "UI-I"); addMapping("UI", 1, 1, "UI-BI")

INK = HexColor("#1F2328")
SOFT = HexColor("#5B6470")
FAINT = HexColor("#9AA3AD")
LINE = HexColor("#DDE1E6")
SUNK = HexColor("#F4F5F7")
PAPER = HexColor("#FBFAF7")
ACCENT = HexColor("#2F6F6A")      # calm teal: step numbers, primary buttons
ACCENT_BG = HexColor("#E6F0EE")
CALL = HexColor("#D9534F")        # the "click here" ring
TIP_BG = HexColor("#FFF6E0")
TIP_LINE = HexColor("#F0C75E")

W, H = A4
MARGIN = 20 * mm

s_title = ParagraphStyle("t", fontName="UI-B", fontSize=30, leading=36, textColor=INK)
s_sub = ParagraphStyle("s", fontName="UI-L", fontSize=15, leading=21, textColor=SOFT)
s_h = ParagraphStyle("h", fontName="UI-B", fontSize=17, leading=22, textColor=INK, spaceAfter=4)
s_body = ParagraphStyle("b", fontName="UI", fontSize=12, leading=18, textColor=INK)
s_small = ParagraphStyle("sm", fontName="UI", fontSize=10.5, leading=15, textColor=SOFT)
s_tip = ParagraphStyle("tip", fontName="UI", fontSize=11, leading=16, textColor=INK)
s_q = ParagraphStyle("q", fontName="UI-SB", fontSize=12, leading=16, textColor=INK)


# ── drawing helpers ─────────────────────────────────────────
def rrect(c, x, y, w, h, r=6, fill=white, stroke=LINE, sw=1):
    c.setFillColor(fill)
    if stroke is None:
        c.roundRect(x, y, w, h, r, stroke=0, fill=1)
    else:
        c.setStrokeColor(stroke); c.setLineWidth(sw)
        c.roundRect(x, y, w, h, r, stroke=1, fill=1)


def text(c, x, y, s, size=10, font="UI", color=INK, anchor="l"):
    c.setFont(font, size); c.setFillColor(color)
    {"l": c.drawString, "c": c.drawCentredString, "r": c.drawRightString}[anchor](x, y, s)


def bar(c, x, y, w, h=5, color=LINE):
    rrect(c, x, y, w, h, h / 2, fill=color, stroke=None)


def button(c, x, y, w, h, label, primary=True, size=11):
    rrect(c, x, y, w, h, 6, fill=ACCENT if primary else white, stroke=None if primary else LINE)
    text(c, x + w / 2, y + h / 2 - size * 0.35, label, size, "UI-SB", white if primary else INK, "c")


def ring(c, x, y, w, h, label=None, label_side="right"):
    """The red ring that says: this is the thing to press."""
    pad = 5
    c.setStrokeColor(CALL); c.setLineWidth(2.4)
    c.roundRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad, 9, stroke=1, fill=0)
    if label:
        c.setFont("UI-B", 10.5)
        tw = c.stringWidth(label, "UI-B", 10.5) + 16
        if label_side == "right":
            lx, ly = x + w + pad + 12, y + h / 2 - 10
            c.line(x + w + pad, y + h / 2, lx, y + h / 2)
        else:
            lx, ly = x - pad - 12 - tw, y + h / 2 - 10
            c.line(x - pad, y + h / 2, lx + tw, y + h / 2)
        rrect(c, lx, ly, tw, 20, 10, fill=CALL, stroke=None)
        text(c, lx + tw / 2, ly + 6, label, 10.5, "UI-B", white, "c")


def browser(c, x, y, w, h, url):
    rrect(c, x, y, w, h, 8, fill=white, stroke=LINE)
    c.setFillColor(SUNK); c.rect(x + 1, y + h - 24, w - 2, 23, stroke=0, fill=1)
    for i, col in enumerate(("#E8A39E", "#EBCB8B", "#A3C9A0")):
        c.setFillColor(HexColor(col)); c.circle(x + 14 + i * 12, y + h - 12, 3.6, stroke=0, fill=1)
    rrect(c, x + 60, y + h - 19, w - 80, 14, 7, fill=white, stroke=LINE, sw=0.6)
    text(c, x + 70, y + h - 15.5, url, 8, "UI", SOFT)


class Picture(Flowable):
    """A drawn screen. Each `draw_*` below is one of them."""

    def __init__(self, fn, height=180):
        super().__init__()
        self.fn, self.h = fn, height

    def wrap(self, aw, ah):
        self.w = aw
        return aw, self.h

    def draw(self):
        c = self.canv
        rrect(c, 0, 0, self.w, self.h, 10, fill=PAPER, stroke=None)
        self.fn(c, self.w, self.h)


def draw_email(c, w, h):
    x, y, bw, bh = 40, 14, w - 80, h - 28
    rrect(c, x, y, bw, bh, 8)
    text(c, x + 16, y + bh - 22, "Inbox", 9, "UI-SB", SOFT)
    c.setStrokeColor(LINE); c.line(x, y + bh - 32, x + bw, y + bh - 32)
    text(c, x + 16, y + bh - 50, f"{WORKSPACE} has invited you to join them in Slack", 11.5, "UI-B")
    text(c, x + 16, y + bh - 66, "From: Slack   ·   feedback@slack.com", 9, "UI", SOFT)
    bar(c, x + 16, y + bh - 82, bw * 0.62)
    bar(c, x + 16, y + bh - 93, bw * 0.48)
    button(c, x + 16, y + 22, 120, 28, "Join Now")
    ring(c, x + 16, y + 22, 120, 28, "Click this button")


def draw_signin(c, w, h):
    x, y, bw, bh = 40, 10, w - 80, h - 20
    browser(c, x, y, bw, bh, "slack.com")
    cx = x + bw / 2
    text(c, cx, y + bh - 44, f"Join {WORKSPACE} on Slack", 13, "UI-B", INK, "c")
    fw = 230
    button(c, cx - fw / 2, y + 90, fw, 22, "Continue with Google", primary=False, size=10)
    text(c, cx, y + 76, "or", 9, "UI", FAINT, "c")
    rrect(c, cx - fw / 2, y + 48, fw, 22, 6)
    text(c, cx - fw / 2 + 10, y + 55, "you@youremail.com", 10, "UI", SOFT)
    ring(c, cx - fw / 2, y + 48, fw, 22, "Your email", "left")
    button(c, cx - fw / 2, y + 14, fw, 24, "Continue", size=10.5)
    ring(c, cx - fw / 2, y + 14, fw, 24, "Then this")


def draw_code(c, w, h):
    x, y, bw, bh = 40, 10, w - 80, h - 20
    browser(c, x, y, bw, bh, "slack.com")
    cx = x + bw / 2
    text(c, cx, y + bh - 44, "Check your email for a code", 13, "UI-B", INK, "c")
    text(c, cx, y + bh - 60, "We've sent a 6-character code to you@youremail.com", 9.5, "UI", SOFT, "c")
    box, gap = 30, 8
    total = 6 * box + 5 * gap + 16
    sx = cx - total / 2
    for i, ch in enumerate("ABC-123".replace("-", "")):
        bx = sx + i * (box + gap) + (16 if i >= 3 else 0)
        rrect(c, bx, y + 36, box, 36, 6, stroke=ACCENT, sw=1.2)
        text(c, bx + box / 2, y + 47, ch, 15, "UI-B", INK, "c")
    text(c, sx + 3 * (box + gap) + 4, y + 48, "–", 14, "UI", FAINT)
    ring(c, sx, y + 36, total, 36)
    text(c, cx, y + 12, "Type the code from the email here", 10, "UI-B", CALL, "c")


def draw_profile(c, w, h):
    x, y, bw, bh = 40, 10, w - 80, h - 20
    browser(c, x, y, bw, bh, "app.slack.com")
    lx = x + 40
    text(c, lx, y + bh - 44, "What's your name?", 13, "UI-B")
    text(c, lx, y + bh - 59, "This is how the team will see you.", 9.5, "UI", SOFT)
    rrect(c, lx, y + 62, 220, 25, 6)
    text(c, lx + 10, y + 70, "Sarah Thompson", 11, "UI", INK)
    ring(c, lx, y + 62, 220, 25)
    button(c, lx, y + 16, 110, 26, "Next")
    ring(c, lx, y + 16, 110, 26, "Then Next")
    px = x + bw - 120
    c.setFillColor(ACCENT_BG); c.circle(px + 40, y + 88, 30, stroke=0, fill=1)
    text(c, px + 40, y + 81, "ST", 20, "UI-B", ACCENT, "c")
    text(c, px + 40, y + 44, "Photo (optional)", 9, "UI", SOFT, "c")


def draw_open(c, w, h):
    x, y, bw, bh = 40, 10, w - 80, h - 20
    browser(c, x, y, bw, bh, "app.slack.com")
    cx = x + bw / 2
    text(c, cx, y + bh - 44, "Where would you like to use Slack?", 13, "UI-B", INK, "c")
    cw, ch = 175, 70
    for i, (t1, t2, primary) in enumerate((
        ("Use Slack in your browser", "Nothing to install", True),
        ("Download the Slack app", "For Windows or Mac", False),
    )):
        bx = cx - cw - 10 + i * (cw + 20)
        rrect(c, bx, y + 28, cw, ch, 8, fill=ACCENT_BG if primary else white, stroke=ACCENT if primary else LINE)
        text(c, bx + cw / 2, y + 28 + ch - 30, t1, 10.5, "UI-B", INK, "c")
        text(c, bx + cw / 2, y + 28 + ch - 48, t2, 9, "UI", SOFT, "c")
        if primary:
            ring(c, bx, y + 28, cw, ch)
    text(c, cx - cw / 2 - 10, y + 10, "Easiest choice", 9.5, "UI-B", CALL, "c")


def draw_workspace(c, w, h):
    x, y, bw, bh = 30, 10, w - 60, h - 20
    browser(c, x, y, bw, bh, "app.slack.com")
    side = 140
    c.setFillColor(HexColor("#2E3B45")); c.rect(x + 1, y + 1, side, bh - 26, stroke=0, fill=1)
    text(c, x + 14, y + bh - 46, WORKSPACE, 10.5, "UI-B", white)
    text(c, x + 14, y + bh - 70, "Channels", 8.5, "UI-SB", HexColor("#AAB6C0"))
    chans = ["# general", "# your-project", "# questions"]
    for i, ch in enumerate(chans):
        cy = y + bh - 90 - i * 18
        if i == 1:
            rrect(c, x + 8, cy - 5, side - 16, 16, 4, fill=ACCENT, stroke=None)
        text(c, x + 14, cy, ch, 9.5, "UI-SB" if i == 1 else "UI", white)
    mx = x + side + 16
    text(c, mx, y + bh - 46, "# your-project", 11, "UI-B")
    for i, (who, wid) in enumerate((("Janelle", 0.55), ("Carissa", 0.4))):
        my = y + bh - 70 - i * 30
        c.setFillColor(ACCENT_BG); c.circle(mx + 9, my - 3, 9, stroke=0, fill=1)
        text(c, mx + 24, my, who, 9.5, "UI-B")
        bar(c, mx + 24, my - 13, (bw - side - 60) * wid)
    mw = bw - side - 34
    rrect(c, mx, y + 14, mw, 24, 6)
    text(c, mx + 10, y + 22, "Message #your-project", 9.5, "UI", FAINT)
    text(c, mx + mw - 10, y + 22, "Type here, press Enter", 9.5, "UI-B", CALL, "r")
    ring(c, mx, y + 14, mw, 24)


def draw_phone(c, w, h):
    for i, (title, lines) in enumerate((
        ("App Store / Google Play", ["Search: Slack", "Install"]),
        ("Slack app", ["Sign in with the email", "you used before"]),
    )):
        pw, ph = 104, h - 22
        px = w / 2 - 150 + i * 196
        py = 11
        rrect(c, px, py, pw, ph, 16, fill=white, stroke=INK, sw=1.6)
        rrect(c, px + pw / 2 - 16, py + ph - 10, 32, 4, 2, fill=INK, stroke=None)
        text(c, px + pw / 2, py + ph - 34, title, 8, "UI-B", INK, "c")
        c.setFillColor(ACCENT_BG); c.roundRect(px + pw / 2 - 18, py + ph - 82, 36, 36, 9, stroke=0, fill=1)
        text(c, px + pw / 2, py + ph - 71, "#", 20, "UI-B", ACCENT, "c")
        for j, ln in enumerate(lines):
            text(c, px + pw / 2, py + 64 - j * 12, ln, 8, "UI", SOFT, "c")
        button(c, px + 14, py + 14, pw - 28, 20, "Install" if i == 0 else "Sign in", size=8.5)
        if i == 0:
            ring(c, px + 14, py + 14, pw - 28, 20)
    c.setStrokeColor(FAINT); c.setLineWidth(1.4)
    ax = w / 2 - 150 + 104 + 18
    c.line(ax, h / 2, ax + 56, h / 2)
    c.line(ax + 50, h / 2 + 5, ax + 56, h / 2); c.line(ax + 50, h / 2 - 5, ax + 56, h / 2)


# ── page furniture ──────────────────────────────────────────
def on_page(c, doc):
    c.saveState()
    c.setFillColor(white); c.rect(0, 0, W, H, stroke=0, fill=1)
    if doc.page > 1:
        text(c, MARGIN, 12 * mm, f"Joining {WORKSPACE} on Slack", 9, "UI", FAINT)
        text(c, W - MARGIN, 12 * mm, f"Page {doc.page}", 9, "UI", FAINT, "r")
    c.restoreState()


def on_cover(c, doc):
    c.saveState()
    c.setFillColor(ACCENT_BG); c.rect(0, H - 96 * mm, W, 96 * mm, stroke=0, fill=1)
    c.restoreState()


class StepHead(Flowable):
    def __init__(self, n, title):
        super().__init__()
        self.n, self.title = n, title

    def wrap(self, aw, ah):
        return aw, 34

    def draw(self):
        c = self.canv
        c.setFillColor(ACCENT); c.circle(15, 15, 15, stroke=0, fill=1)
        text(c, 15, 9.5, str(self.n), 15, "UI-B", white, "c")
        text(c, 42, 9, self.title, 17, "UI-B", INK)


def tip(content, label="Tip"):
    t = Table([[Paragraph(f"<font name='UI-B'>{label}:</font> {content}", s_tip)]], colWidths=[W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), TIP_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 3, TIP_LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t


def step(n, title, body, pic, extra=None):
    parts = [StepHead(n, title), Spacer(1, 6), Paragraph(body, s_body), Spacer(1, 10), Picture(pic)]
    if extra is not None:
        parts += [Spacer(1, 8), extra]
    return KeepTogether(parts + [Spacer(1, 16)])


# ── content ─────────────────────────────────────────────────
story = []

story += [
    Spacer(1, 28 * mm),
    Paragraph("How to join our Slack", s_title),
    Spacer(1, 8),
    Paragraph(f"A simple, step-by-step guide to joining {WORKSPACE} on Slack from the email invitation. "
              "It takes about 5 minutes and you don't need any technical knowledge.", s_sub),
    Spacer(1, 30 * mm),
    Paragraph("What is Slack?", s_h),
    Paragraph("Slack is a messaging app, a bit like WhatsApp for work. We use it to share updates, photos and "
              "questions about your project in one place, so nothing gets lost in long email chains.", s_body),
    Spacer(1, 16),
    Paragraph("Before you start, you'll need", s_h),
]
checklist = [
    ("1", "The invitation email from Slack. It is sent to the email address you gave us."),
    ("2", "Access to that same email inbox, because Slack will email you a short code."),
    ("3", "About 5 minutes, on a computer or a phone."),
]
t = Table([[Paragraph(f"<font name='UI-B' color='#2F6F6A'>{n}</font>", s_body), Paragraph(txt, s_body)]
           for n, txt in checklist], colWidths=[10 * mm, W - 2 * MARGIN - 10 * mm])
t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                       ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
story += [t, Spacer(1, 10),
          Paragraph("The pictures in this guide are simplified drawings. Your screen may look slightly different, "
                    "but the buttons and words will be the same. <font name='UI-B' color='#D9534F'>The red outline</font> "
                    "always shows what to click or fill in.", s_small),
          PageBreak()]

story.append(step(
    1, "Open the invitation email",
    f"Look in your inbox for an email with the subject <b>“{WORKSPACE} has invited you to join them in Slack”</b>. "
    "Open it and click the <b>Join Now</b> button.",
    draw_email,
    tip("Can't find it? Check your <b>Spam</b> or <b>Junk</b> folder, and the Promotions tab if you use Gmail. "
        "You can also search your inbox for the word <b>Slack</b>."),
))
story.append(step(
    2, "Enter your email address",
    "A web page opens. Type your email address and click <b>Continue</b>. If you use Gmail, you can click "
    "<b>Continue with Google</b> instead and skip step 3.",
    draw_signin,
    tip("Use the <b>same email address the invitation was sent to</b>. A different address won't be let in.",
        "Important"),
))
story.append(step(
    3, "Type in the code Slack emails you",
    "Slack emails you a 6-character code to prove the address is yours. Go back to your inbox, open the new "
    "email from Slack, and type the code into the boxes. You don't have to press anything else; it moves on by itself.",
    draw_code,
    tip("The code arrives within a minute. If it doesn't, check Spam again. You never need to create or "
        "remember a password."),
))
story.append(step(
    4, "Add your name",
    "Type your full name so the team knows who you are, then click <b>Next</b>. "
    "Adding a photo is optional; you can skip it or add one later.",
    draw_profile,
))
story.append(step(
    5, "Choose how to open Slack",
    "Slack may ask where you'd like to use it. The easiest choice is <b>Use Slack in your browser</b>. "
    "It works straight away with nothing to install. If you prefer, you can download the app instead.",
    draw_open,
))
story.append(step(
    6, "You're in! Say hello",
    "You'll see the channels on the left. Each channel is a group conversation about one topic. "
    "Click your project's channel, type a message in the box at the bottom and press <b>Enter</b> to send it.",
    draw_workspace,
    tip("To get back to Slack later, go to <b>app.slack.com</b> in your browser, or open the Slack app. "
        "Sign in with the same email address and a new code will be emailed to you."),
))
story.append(step(
    7, "Optional: get Slack on your phone",
    "Install the free <b>Slack</b> app from the App Store (iPhone) or Google Play (Android). Open it, "
    "choose <b>Sign in</b> and enter the same email address. Slack emails you a code, just like in step 3.",
    draw_phone,
    tip("On your phone, allow notifications when Slack asks. You'll then get a message whenever "
        "we post an update about your project."),
))

faq = [
    ("I never got the invitation email.",
     "Check Spam, Junk and Gmail's Promotions tab. Still nothing? Tell us which email address you'd like to "
     "use and we'll send a new invitation."),
    ("It says my invitation has expired.",
     "Invitations stop working after a while (usually 30 days). Just ask us and we'll send a fresh one."),
    ("It says I can't join with this email address.",
     "You're probably using a different address from the one we invited. Sign in with the address the "
     "invitation was sent to, or ask us to invite your other address."),
    ("The code isn't arriving.",
     "Wait a minute and check Spam. On the Slack page you can ask for the code to be sent again."),
    ("I closed the page halfway through.",
     "That's fine. Click <b>Join Now</b> in the invitation email again and carry on from where you stopped."),
    ("Do I have to pay for Slack?",
     "No. Joining our workspace is completely free for you."),
]
story.append(PageBreak())
story += [Paragraph("Having trouble?", ParagraphStyle("h1", parent=s_h, fontSize=22, leading=28)),
          Spacer(1, 4),
          Paragraph("The most common questions, and what to do.", s_sub), Spacer(1, 14)]
rows = [[Paragraph(q, s_q), Paragraph(a, s_body)] for q, a in faq]
t = Table(rows, colWidths=[62 * mm, W - 2 * MARGIN - 62 * mm])
t.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.6, LINE),
    ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, -1), 14),
]))
story += [t, Spacer(1, 24),
          tip("If you get stuck at any point, just reply to our email or give us a call. We're happy to walk "
              "you through it.", "Still stuck")]

doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                      topMargin=18 * mm, bottomMargin=20 * mm,
                      title="How to join our Slack", author=WORKSPACE,
                      subject="Step-by-step guide to joining Slack from an email invitation")
frame = Frame(MARGIN, 20 * mm, W - 2 * MARGIN, H - 38 * mm, id="f", leftPadding=0, rightPadding=0,
              topPadding=0, bottomPadding=0)
doc.addPageTemplates([
    PageTemplate(id="cover", frames=[frame], onPage=lambda c, d: (on_page(c, d), on_cover(c, d)),
                 autoNextPageTemplate="body"),
    PageTemplate(id="body", frames=[frame], onPage=on_page),
])
doc.build(story)
print("ok", OUT)
