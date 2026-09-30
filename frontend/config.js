const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
window.CODEMARKET_API_URL = isLocalHost
	? `${window.location.origin}/api`
	: "https://YOUR-RENDER-SERVICE.onrender.com/api";
