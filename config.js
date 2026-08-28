/*
  ============================================================
   ضع مفاتيح الـ API الخاصة فيك هنا فقط. هذا الملف لا يُرفع
   لأي مكان عام — هو يعمل محليًا من متصفحك فقط.
  ============================================================
*/

const CONFIG = {
  // مفتاح OpenAI (يُستخدم لـ Whisper API "تفريغ الصوت" و GPT "اختيار اللحظات")
  OPENAI_API_KEY: "ضع_مفتاح_OpenAI_هنا",

  // اختياري: لو تبغى تستخدم Claude بدل GPT لتحليل النص، فعّل هذا
  USE_ANTHROPIC_FOR_ANALYSIS: false,
  ANTHROPIC_API_KEY: "ضع_مفتاح_Anthropic_هنا",

  // عدد المقاطع المطلوب توليدها من كل فيديو
  NUM_CLIPS: 6,

  // الحد الأدنى/الأقصى لطول المقطع بالثواني
  MIN_CLIP_DURATION: 15,
  MAX_CLIP_DURATION: 60,
};
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
