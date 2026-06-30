// Default configuration constants
export const DEFAULT_CHAIN = 'main';
export const ADMIN_ORIGINATOR = 'admin.com';
export const DEFAULT_USE_WAB = false;
export const MESSAGEBOX_HOST = 'https://messagebox.babbage.systems';
// Sensible public defaults so a newcomer never has to type a server URL. These
// pre-fill the WAB / storage / message-box fields; they're only USED when the
// user opts into WAB or remote storage (Advanced), but seeding them removes the
// manual-entry friction that previously blocked the WAB path.
export const DEFAULT_WAB_URL = 'https://wab.babbage.systems';
export const DEFAULT_STORAGE_URL = 'https://storage.babbage.systems';
