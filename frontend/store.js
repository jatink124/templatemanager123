/* =========================================================
   CodeMarket – shared localStorage "backend"
   Every page (storefront + seller dashboard) reads/writes here.
   ========================================================= */
(function (global) {
  const KEYS = {
    templates: "cm_templates",
    categories: "cm_categories",
    sales: "cm_sales",
    settings: "cm_settings",
    cart: "cm_cart",
    wishlist: "cm_wishlist",
  };

  const PLACEHOLDER =
    "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=600&q=80";

  const DEFAULT_CATEGORIES = [
    { id: "c1", name: "Web Templates", icon: "ph-desktop", color: "brand", active: true },
    { id: "c2", name: "Admin Templates", icon: "ph-squares-four", color: "indigo", active: true },
    { id: "c3", name: "eCommerce", icon: "ph-shopping-cart", color: "blue", active: true },
    { id: "c4", name: "Landing Pages", icon: "ph-file-text", color: "green", active: true },
    { id: "c5", name: "UI Kits", icon: "ph-bounding-box", color: "purple", active: true },
    { id: "c6", name: "Others", icon: "ph-dots-three-circle", color: "gray", active: true },
  ];

  const DEFAULT_TEMPLATES = [
    {
      id: "t1",
      title: "SaaS Landing Page",
      description: "A conversion focused landing page for software products.",
      category: "Landing Pages",
      price: 19,
      tags: ["saas", "landing"],
      status: "Published",
      badge: "NEW",
      image:
        "https://images.unsplash.com/photo-1555421689-491a97ff2040?auto=format&fit=crop&w=600&q=80",
      views: 420,
      sales: 12,
      createdAt: "2025-08-28T10:00:00.000Z",
    },
    {
      id: "t2",
      title: "Admin Dashboard Pro",
      description: "Complete admin panel with charts, tables and dark mode.",
      category: "Admin Templates",
      price: 24,
      tags: ["admin", "dashboard"],
      status: "Published",
      badge: "BEST SELLER",
      image:
        "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=600&q=80",
      views: 980,
      sales: 26,
      createdAt: "2025-08-20T10:00:00.000Z",
    }
  ];

  const DEFAULT_SETTINGS = {
    fullName: "Jatin K",
    email: "jatin@codemarket.dev",
    storeName: "CodeMarket Studio",
    storeUrl: "codemarket.dev/studio",
    bio: "I build clean, production ready templates.",
    payoutMethod: "PayPal",
    payoutEmail: "jatin@codemarket.dev",
    notifySales: true,
    notifyReviews: true,
    notifyNews: false,
  };

 // Store data in memory
  let memoryDB = {};
  const API_URL = window.CODEMARKET_API_URL || `${window.location.origin}/api`;
  function read(key, fallback) {
    return memoryDB[key] || fallback;
  }

  // Write to memory AND send to the Node backend
  function write(key, value) {
    memoryDB[key] = value; // Update memory immediately
    
    // Send to backend in the background
    fetch(`${API_URL}/data/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
    }).catch(err => console.error("Failed to save to backend:", err));

    document.dispatchEvent(new CustomEvent("cm:changed", { detail: { key } }));
  }

  const Store = {
    KEYS,
    PLACEHOLDER,

    seed() {
      if (!localStorage.getItem(KEYS.categories)) write(KEYS.categories, DEFAULT_CATEGORIES);
      if (!localStorage.getItem(KEYS.templates)) write(KEYS.templates, DEFAULT_TEMPLATES);
      if (!localStorage.getItem(KEYS.settings)) write(KEYS.settings, DEFAULT_SETTINGS);
      if (!localStorage.getItem(KEYS.sales)) write(KEYS.sales, []);
      return Store;
    },

    reset() {
      Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
      Store.seed();
    },

    templates() {
      return read(KEYS.templates, []);
    },
    settings() {
      return read(KEYS.settings, DEFAULT_SETTINGS);
    },
    stats() {
      const templates = Store.templates();
      const sales = Store.sales();
      return {
        templates: templates.length,
        published: templates.filter((t) => t.status === "Published").length,
        salesCount: sales.length,
        views: templates.reduce((total, t) => total + Number(t.views || 0), 0),
        revenue: sales.reduce((total, sale) => total + Number(sale.amount || 0), 0),
      };
    },
    published() {
      return Store.templates().filter((t) => t.status === "Published");
    },
    template(id) {
      return Store.templates().find((t) => t.id === id) || null;
    },
    addTemplate(data) {
      const list = Store.templates();
      const item = {
        id: "t" + Date.now(),
        title: data.title,
        description: data.description || "",
        category: data.category || "Others",
        price: Number(data.price) || 0,
        tags: data.tags || [],
        status: data.status || "Published",
        badge: "NEW",
        image: data.image || PLACEHOLDER,
        gallery: data.gallery || [],
        demoUrl: data.demoUrl || "",
        fileName: data.fileName || "",
        appData: data.appData || null,
        views: 0,
        sales: 0,
        createdAt: new Date().toISOString(),
      };
      list.unshift(item);
      write(KEYS.templates, list);
      return item;
    },

    updateTemplate(id, patch) {
      const list = Store.templates().map((t) => (t.id === id ? { ...t, ...patch } : t));
      write(KEYS.templates, list);
    },
    removeTemplate(id) {
      write(
        KEYS.templates,
        Store.templates().filter((t) => t.id !== id)
      );
    },
    countView(id) {
      const t = Store.template(id);
      if (t) Store.updateTemplate(id, { views: (t.views || 0) + 1 });
    },

    categories() {
      return read(KEYS.categories, []);
    },
    activeCategories() {
      return Store.categories().filter((c) => c.active);
    },
    category(id) {
      return Store.categories().find((c) => c.id === id) || null;
    },
    addCategory(data) {
      const list = Store.categories();
      const item = {
        id: "c" + Date.now(),
        name: (data.name || "Untitled").trim(),
        description: data.description || "",
        icon: data.icon || "ph-squares-four",
        color: data.color || "brand",
        active: data.active !== false,
        createdAt: new Date().toISOString(),
      };
      list.push(item);
      write(KEYS.categories, list);
      return item;
    },
    updateCategory(id, patch) {
      const before = Store.category(id);
      const list = Store.categories().map((c) => (c.id === id ? { ...c, ...patch } : c));
      write(KEYS.categories, list);
      // keep templates in sync when a category is renamed
      if (before && patch.name && patch.name !== before.name) {
        write(
          KEYS.templates,
          Store.templates().map((t) => (t.category === before.name ? { ...t, category: patch.name } : t))
        );
      }
    },
    removeCategory(id) {
      const cat = Store.category(id);
      write(
        KEYS.categories,
        Store.categories().filter((c) => c.id !== id)
      );
      if (cat) {
        write(
          KEYS.templates,
          Store.templates().map((t) => (t.category === cat.name ? { ...t, category: "Others" } : t))
        );
      }
    },
    toggleCategory(id) {
      const c = Store.category(id);
      if (c) Store.updateCategory(id, { active: !c.active });
    },
    templatesInCategory(name) {
      return Store.templates().filter((t) => t.category === name).length;
    },

    sales() { return read(KEYS.sales, []); },
    sale(id) {
      return Store.sales().find((s) => s.id === id) || null;
    },
    addSale(data) {
      const list = Store.sales();
      const item = {
        id: "s" + Date.now(),
        templateId: data.templateId || "",
        title: data.title || "Untitled template",
        buyer: data.buyer || "Guest buyer",
        email: data.email || "",
        amount: Number(data.amount) || 0,
        status: data.status || "Completed",
        date: data.date || new Date().toISOString(),
      };
      list.unshift(item);
      write(KEYS.sales, list);
      if (item.templateId) {
        const t = Store.template(item.templateId);
        if (t) Store.updateTemplate(t.id, { sales: (t.sales || 0) + 1 });
      }
      return item;
    },
    updateSale(id, patch) {
      write(
        KEYS.sales,
        Store.sales().map((s) => (s.id === id ? { ...s, ...patch } : s))
      );
    },
    removeSale(id) {
      const sale = Store.sale(id);
      write(
        KEYS.sales,
        Store.sales().filter((s) => s.id !== id)
      );
      if (sale && sale.templateId) {
        const t = Store.template(sale.templateId);
        if (t) Store.updateTemplate(t.id, { sales: Math.max(0, (t.sales || 0) - 1) });
      }
    },

    saveSettings(patch) {
      const next = { ...Store.settings(), ...patch };
      write(KEYS.settings, next);
      return next;
    },
    resetSettings() {
      write(KEYS.settings, DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    },

    cart() { return read(KEYS.cart, []); },
    wishlist() { return read(KEYS.wishlist, []); },


    money(n) {
      return "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    },
    date(iso) {
      try {
        return new Date(iso).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      } catch (e) {
        return "";
      }
    },
    escape(str) {
      return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);
    },

    openPreview(id, opts) {
      const t = typeof id === "string" ? Store.template(id) : id;
      if (!t) return;
      opts = opts || {};
      if (typeof id === "string") Store.countView(id);

      const shots = [t.image].concat(t.gallery || []).filter(Boolean);
      const esc = Store.escape;
      
      // Select best preview mode based on available data
      let mode = t.appData ? "app" : (t.demoUrl ? "live" : "shots");
      let shot = 0;

      Store.closePreview();
      const wrap = document.createElement("div");
      wrap.id = "cm-preview";
      wrap.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:rgba(15,12,35,.72);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px";

      function stage() {
        if (mode === "app" && t.appData) {
            return `<iframe id="cm-app-frame" title="Interactive preview of ${esc(t.title)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" style="width:100%;height:100%;border:0;background:#fff;display:block"></iframe>`;
        }
        if (mode === "live" && t.demoUrl) {
          return `<iframe src="${esc(t.demoUrl)}" title="Live preview of ${esc(t.title)}" style="width:100%;height:100%;border:0;background:#fff"></iframe>`;
        }
        return `<div style="width:100%;height:100%;overflow:auto;background:#f6f6fb;display:flex;align-items:flex-start;justify-content:center">
            <img src="${esc(shots[shot] || PLACEHOLDER)}" alt="${esc(t.title)} preview" style="max-width:100%;display:block">
          </div>`;
      }

      function paint() {
        wrap.innerHTML = `
          <div style="background:#fff;border-radius:18px;overflow:hidden;width:min(1200px,100%);height:min(90vh,900px);display:flex;flex-direction:column;box-shadow:0 30px 80px -20px rgba(0,0,0,.6)">
            <div style="display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid #eee;background:#fff">
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;color:#111827;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(t.category)} · ${Store.money(t.price)}</div>
              </div>
              
              <div style="display:flex;gap:8px;background:#f3f4f6;padding:4px;border-radius:11px">
                  ${t.appData ? `<button data-mode="app" style="${mode === "app" ? "background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.1)" : "background:transparent;color:#6b7280"};border:0;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Interactive App</button>` : ""}
                  ${t.demoUrl ? `<button data-mode="live" style="${mode === "live" ? "background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.1)" : "background:transparent;color:#6b7280"};border:0;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Live demo</button>` : ""}
                  <button data-mode="shots" style="${mode === "shots" ? "background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.1)" : "background:transparent;color:#6b7280"};border:0;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Screens (${shots.length})</button>
              </div>

              <button data-close style="background:#f3f4f6;border:0;width:34px;height:34px;border-radius:9px;font-size:18px;line-height:1;cursor:pointer;color:#374151;margin-left:8px;display:flex;align-items:center;justify-content:center">&times;</button>
            </div>

            <div style="flex:1;min-height:0;position:relative;background:#f9fafb">
              ${stage()}
              ${mode === "shots" && shots.length > 1 ? `
                <button data-shot="-1" style="position:absolute;left:16px;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;border:0;background:rgba(17,12,40,.8);color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15)">&#8249;</button>
                <button data-shot="1" style="position:absolute;right:16px;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;border:0;background:rgba(17,12,40,.8);color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15)">&#8250;</button>` : ""}
            </div>
          </div>`;

        wrap.querySelectorAll("[data-mode]").forEach((b) =>
          b.addEventListener("click", () => {
            mode = b.dataset.mode;
            paint();
          })
        );
        wrap.querySelectorAll("[data-shot]").forEach((b) =>
          b.addEventListener("click", () => {
            shot = (shot + Number(b.dataset.shot) + shots.length) % shots.length;
            paint();
          })
        );
        wrap.querySelector("[data-close]").addEventListener("click", Store.closePreview);

        // Interactive App player: run the uploaded ZIP like a local server
        if (mode === "app" && t.appData) {
            const frame = wrap.querySelector("#cm-app-frame");
            const htmlViews = Object.keys(t.appData).filter((k) => /\.html?$/i.test(k));
            const entry = t.appData["index.html"] ? "index.html" : htmlViews[0];
            if (entry) {
                Store._navHandler = (e) => {
                    const target = e.data && e.data.cmNav;
                    if (target && t.appData[target] != null) {
                        frame.srcdoc = Store.buildAppDocument(t.appData, target);
                    }
                };
                window.addEventListener("message", Store._navHandler);
                frame.srcdoc = Store.buildAppDocument(t.appData, entry);
            }
        }
      }

      wrap.addEventListener("click", (e) => {
        if (e.target === wrap) Store.closePreview();
      });
      document.addEventListener("keydown", Store._previewKeys);
      document.body.appendChild(wrap);
      document.body.style.overflow = "hidden";
      paint();
    },

    _previewKeys(e) {
      if (e.key === "Escape") Store.closePreview();
    },

    closePreview() {
      const el = document.getElementById("cm-preview");
      if (el) el.remove();
      document.removeEventListener("keydown", Store._previewKeys);
      if (Store._navHandler) {
        window.removeEventListener("message", Store._navHandler);
        Store._navHandler = null;
      }
      document.body.style.overflow = "";
    },

    /*
     * Build a self-contained HTML document that runs an uploaded multi-file
     * app exactly like a local machine would:
     *  - fetch("page.html") / fetch("style.css") are answered from the ZIP
     *  - <a href="page.html"> navigates inside the preview (postMessage up)
     *  - <img src>/<link href>/<script src>/url() pointing at ZIP files are
     *    swapped for their stored content
     */
  buildAppDocument(files, entry) {
      // 1. Create a working copy of the uploaded files
      const proc = { ...files };
      
      // 2. Identify all binary assets (images, fonts converted to Base64)
      const assets = Object.keys(proc).filter(k => typeof proc[k] === "string" && proc[k].startsWith("data:"));

      // 3. Inject data URLs into ALL text files (HTML, CSS, JS) so dynamically fetched views also get the images
      Object.keys(proc).forEach(fileName => {
        if (typeof proc[fileName] === "string" && !proc[fileName].startsWith("data:")) {
          let text = proc[fileName];
          
          assets.forEach(asset => {
            const dataUrl = proc[asset];
            const safeName = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Match paths even if they are nested in folders (e.g., assets/images/headphones.png)
            const rxDouble = new RegExp('"[^"]*?' + safeName + '"', 'g');
            const rxSingle = new RegExp("'[^']*?" + safeName + "'", 'g');
            const rxUrl = new RegExp("\\([^)]*?" + safeName + "\\)", 'g');

            text = text.replace(rxDouble, '"' + dataUrl + '"');
            text = text.replace(rxSingle, "'" + dataUrl + "'");
            text = text.replace(rxUrl, "(" + dataUrl + ")");
          });
          proc[fileName] = text;
        }
      });

      // 4. Stringify the fully processed files for the iframe's internal mock server
      const filesJson = JSON.stringify(proc).replace(/</g, "\\u003c");
      const html = proc[entry] || "";

      // 5. The bootstrap logic that intercepts fetch() and navigation inside the iframe
      const bootstrap =
        "<script>(function(){" +
        "var FILES=" + filesJson + ";" +
        "function pick(u){try{u=String(u);if(/^(https?:|data:|blob:|mailto:|#)/.test(u))return null;var p=u.split('?')[0].split('#')[0].split('/');var n=decodeURIComponent(p[p.length-1]);return FILES[n]!=null?n:null;}catch(e){return null;}}" +
        "var of=window.fetch?window.fetch.bind(window):null;" +
        "window.fetch=function(u,o){var n=pick(u);if(n){var c=FILES[n];var m=n.endsWith('.css')?'text/css':n.endsWith('.js')?'text/javascript':n.endsWith('.json')?'application/json':'text/html';return Promise.resolve(new Response(c,{status:200,headers:{'Content-Type':m}}));}return of?of(u,o):Promise.reject(new Error('not found: '+u));};" +
        "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var n=pick(a.getAttribute('href'));if(n){e.preventDefault();parent.postMessage({cmNav:n},'*');}},true);" +
        "})();<\/script>";

      return bootstrap + html;
    },

    fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    },
    toast(message) {
      let host = document.getElementById("cm-toast");
      if (!host) {
        host = document.createElement("div");
        host.id = "cm-toast";
        host.style.cssText =
          "position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px";
        document.body.appendChild(host);
      }
      const el = document.createElement("div");
      el.textContent = message;
      el.style.cssText =
        "background:#110c28;color:#fff;padding:12px 18px;border-radius:12px;font-size:13px;font-weight:600;box-shadow:0 10px 30px -10px rgba(0,0,0,.5)";
      host.appendChild(el);
      setTimeout(() => el.remove(), 2400);
    }
  };

 global.Store = Store;

  // Fetch data from Node.js before starting the app
  fetch(`${API_URL}/data`)
    .then(res => {
      if (!res.ok) throw new Error(`Data API returned ${res.status}`);
      return res.json();
    })
    .then(data => {
        memoryDB = data;
        // If the DB is completely empty, run the seeder
        if (Object.keys(memoryDB).length === 0) {
            Store.seed();
        }
        // Tell the UI that the store is ready to be painted
        document.dispatchEvent(new CustomEvent("cm:ready"));
    })
    .catch(err => {
        console.error("Could not load saved data from the backend.", err);
        document.dispatchEvent(new CustomEvent("cm:ready"));
    });

})(window);