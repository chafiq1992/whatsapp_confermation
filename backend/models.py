from typing import Optional, Union, List, Dict
from pydantic import BaseModel

class MessageCreate(BaseModel):
    user_id: str
    message: Union[str, Dict, List]  # For text, grouped images, orders, etc.
    type: str
    from_me: Optional[bool] = None
    status: Optional[str] = None
    wa_message_id: Optional[str] = None
    timestamp: Optional[str] = None
    caption: Optional[str] = None
    price: Optional[str] = None
    transcription: Optional[str] = None
