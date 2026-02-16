# Links & Templates Setup Guide

## Overview

Shield uses **Primary Link** and **Backup Link** settings, along with **Message Templates** to automatically respond to WhatsApp messages. Here's how it all works:

---

## 1. Setting Up Links

### Primary Link
- **What it is:** Your main website/product link that gets inserted into templates
- **Where to set:** Settings page → Links section → Primary Link field
- **Example:** `https://yourwebsite.com` or `https://yourproduct.com/buy`

### Backup Link
- **What it is:** A secondary link (currently stored but not automatically used)
- **Where to set:** Settings page → Links section → Backup Link field
- **Example:** `https://backup-site.com` or alternative product page
- **Note:** Currently stored for future use or manual reference

---

## 2. How Templates Work

### Template Structure

Templates are message formats that Shield uses to respond. You can use the `{{link}}` placeholder anywhere in your template.

**Example Templates:**
```
Hi! Thanks for reaching out. Check this out: {{link}}
Hello! Interested? Visit: {{link}}
Thanks for your message! Learn more here: {{link}}
```

### How `{{link}}` Works

When Shield sends a message:
1. It selects a template (randomly or via AI)
2. It finds `{{link}}` in the template
3. It replaces `{{link}}` with your **Primary Link**
4. Sends the final message

**Example:**
- **Template:** `"Hi! Check this out: {{link}}"`
- **Primary Link:** `https://myshop.com`
- **Final Message Sent:** `"Hi! Check this out: https://myshop.com"`

---

## 3. Step-by-Step Setup

### Step 1: Set Your Primary Link

1. Go to **Settings** page
2. Find the **Links** section
3. Enter your main link in **Primary Link** field:
   ```
   https://yourwebsite.com
   ```
4. Click **Save Settings**

### Step 2: Create Templates

1. In the **Message Templates** section
2. Click **Add** button
3. Type your template message
4. Use `{{link}}` where you want the link to appear

**Good Template Examples:**
```
✅ "Hi! Check out our products: {{link}}"
✅ "Thanks for messaging! Visit {{link}} to learn more"
✅ "Hello! Interested? Click here: {{link}}"
```

**Bad Template Examples:**
```
❌ "Hi! Check out our products:" (missing {{link}})
❌ "Visit https://example.com" (hardcoded link - won't use your primary link)
```

### Step 3: Edit Templates

1. Click **Edit** button next to any template
2. Modify the text
3. Click **Save** to confirm
4. Click **Cancel** to discard changes

### Step 4: Remove Templates

1. Click **Remove** button next to any template
2. Template is immediately removed
3. Click **Save Settings** to persist changes

---

## 4. How AI Uses Templates

When AI is enabled, Shield will:

1. **For General Chat:**
   - Respond naturally without using templates
   - Example: User says "Hello" → AI responds: "Hi there! How can I help you?"

2. **For Link/Product Questions:**
   - Detects if user asks about link, website, product, service
   - Selects the best matching template
   - Replaces `{{link}}` with your Primary Link
   - Sends the message

**Example Flow:**
- **User:** "What's your website?"
- **AI detects:** User asking about link
- **AI selects template:** "Check this out: {{link}}"
- **Final message:** "Check this out: https://yourwebsite.com"

---

## 5. Template Best Practices

### ✅ DO:
- Use `{{link}}` placeholder in every template
- Keep templates short (1-2 sentences)
- Make them sound natural and friendly
- Test different variations

### ❌ DON'T:
- Hardcode links directly in templates
- Make templates too long
- Use all caps or spammy language
- Create too many similar templates

---

## 6. Example Setup

### Scenario: You sell a product

**Primary Link:** `https://myshop.com/product`

**Templates:**
1. `"Hi! Check out our product: {{link}}"`
2. `"Thanks for your interest! Learn more: {{link}}"`
3. `"Hello! Want to see what we offer? Visit: {{link}}"`

**What happens:**
- User sends: "What do you sell?"
- AI detects product question
- AI picks template: "Hi! Check out our product: {{link}}"
- Shield sends: "Hi! Check out our product: https://myshop.com/product"

---

## 7. Backup Link (Future Use)

The **Backup Link** is currently stored but not automatically used. You could:
- Use it manually in specific templates
- Set it up as a fallback if primary link fails
- Reference it for your own records

---

## 8. Quick Reference

| Setting | Location | Purpose | Required |
|---------|----------|---------|----------|
| Primary Link | Settings → Links | Main link inserted into templates | ✅ Yes |
| Backup Link | Settings → Links | Secondary link (future use) | ❌ Optional |
| Templates | Settings → Templates | Message formats with `{{link}}` | ✅ Yes |

---

## 9. Troubleshooting

**Q: My link isn't appearing in messages**
- Check that your template contains `{{link}}` (with double curly braces)
- Verify Primary Link is set in Settings
- Make sure you clicked "Save Settings"

**Q: Can I use multiple links in one template?**
- Currently, only `{{link}}` is supported (uses Primary Link)
- You can manually type other links in templates if needed

**Q: How do I change which link is used?**
- Update the Primary Link in Settings
- All templates will automatically use the new link

---

## 10. Summary

1. **Set Primary Link** → Your main website/product URL
2. **Create Templates** → Use `{{link}}` where you want the link
3. **Save Settings** → Click the save button
4. **Done!** → Shield will automatically use templates with your link

The `{{link}}` placeholder is **automatically replaced** with your Primary Link when messages are sent.

