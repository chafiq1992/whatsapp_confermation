import os
import openai
from dotenv import load_dotenv

load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
openai.api_key = OPENAI_API_KEY  # <-- This is needed for Whisper/legacy usage

def transcribe_audio(file_path, expected_languages=None):
    """
    Transcribe audio to text using OpenAI Whisper and clarify expected languages.
    :param file_path: Path to the audio file.
    :param expected_languages: List of allowed languages (for guidance/rendering).
    """
    if expected_languages is None:
        expected_languages = ["ar", "fr"]  # Moroccan Darija (ar), French (fr), English (en)

    language_names = {
        "ar": "Moroccan Darija Arabic",
        "fr": "French",
    }

    system_prompt = (
        "Transcribe the full audio as accurately as possible. "
        "Only use or expect transcription in these languages: "
        + ", ".join(language_names[lang] for lang in expected_languages) +
        ". Do not provide output in any other language, or mark as unknown otherwise."
    )

    with open(file_path, "rb") as audio_file:
        response = openai.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            prompt=system_prompt,
            language=None  # Let model autodetect; prompt guides 
        )
    return response.text

async def chatgpt_reply(prompt: str, context: dict = None, rules: dict = None) -> str:
    """
    Get a reply from ChatGPT, using rules (deny, system_prompt), and context (product, customer info).
    """
    # Deny rules (optional)
    if rules:
        deny_list = rules.get("deny") or []
        if any(x in prompt.lower() for x in deny_list):
            return None

    # Compose system prompt with added context
    system_prompt = (
        (rules.get("system_prompt", "") if rules else "") +
        "\n\nExtra context for this conversation (from backend/data):\n" +
        (str(context) if context else "")
    )

    try:
        # Use AsyncOpenAI for ChatGPT (not for Whisper)
        completion = await openai.AsyncOpenAI(api_key=OPENAI_API_KEY).chat.completions.create(
            model="gpt-4.1",  # or gpt-3.5-turbo
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt}
            ]
        )
        return completion.choices[0].message.content.strip()
    except Exception as e:
        print("❌ ChatGPT error:", e)
        return None
