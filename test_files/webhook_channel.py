from base import BaseChannel

class WebhookChannel(BaseChannel):
    def _generate_payload(self):
        return {'url': self.url}
    
    def get_channel_details(self):
        return {'url': self.url}

