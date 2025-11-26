import abc

class Animal:
    def speak(self):
        pass

class BaseChannel(metaclass=abc.ABCMeta):
    @abc.abstractmethod
    def _generate_payload(self):
        raise NotImplementedError()
    
    @abc.abstractmethod
    def get_channel_details(self):
        raise NotImplementedError()
    
    def _triage_change_trigger(self, aggregate):
        return True

