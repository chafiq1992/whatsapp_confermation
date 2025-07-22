# messenger.py
import os
import httpx

class WhatsAppMessenger:
    def __init__(self):
        self.access_token = os.getenv("WHATSAPP_ACCESS_TOKEN", "your_access_token_here")
        self.phone_number_id = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "your_phone_number_id")
        self.base_url = f"https://graph.facebook.com/v18.0/{self.phone_number_id}"
        self.headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }
    
    async def send_text_message(self, to: str, message: str) -> dict:
        url = f"{self.base_url}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": message}
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            return response.json()
