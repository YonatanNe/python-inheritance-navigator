from base import BaseChannel

class EmailChannel(BaseChannel):
    def _generate_payload(self):
        return {'emails': self.emails}
    
    def _triage_change_trigger(self, aggregate):
        return False

