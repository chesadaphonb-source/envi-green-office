(function () {
  'use strict';

  const state = { view: 'dashboard', folderId: null, query: '', token: null, items: [], request: 0, busy: false, selectedId: null, expanded: false };
  const galleryCards = new Map();
  const listingOptions = { type: 'all', sort: 'name' };
  // โฟลเดอร์/ไฟล์ที่ซ่อนชั่วคราว: ระบุชื่อที่ตรงทั้งหมด (case-sensitive) ต่อ categoryNumber
  const HIDDEN_ITEMS = {
    2: ['ส่งข้อมูลเพื่อให้หมวด 2 ทำประชาสัมพันธ์ ปี 69']
  };
  let appUrl = '';
  let catalogClient;
  let currentRoute = null;
  let historyReady = false;
  let navigationCategories = [];
  let navigationLoading = false;
  let navigationRequest = 0;
  let activeCategory = null;
  let categoryCrumbs = [];
  const categoryGuides = [
    { intro: 'วางนโยบายและแผนงาน เพื่อให้การดำเนินงานสำนักงานสีเขียวเป็นไปในทิศทางเดียวกัน', highlights: ['นโยบายและเป้าหมายด้านสิ่งแวดล้อม', 'แผนการดำเนินงานและผู้รับผิดชอบ', 'การทบทวนและปรับปรุงการดำเนินงาน'], goal: 'มีแนวทางและแผนงานที่ชัดเจน พร้อมขับเคลื่อนอย่างต่อเนื่อง' },
    { intro: 'สื่อสาร สร้างความรู้ความเข้าใจ และเปิดโอกาสให้ทุกคนมีส่วนร่วมดูแลสิ่งแวดล้อม', highlights: ['การสื่อสารและประชาสัมพันธ์', 'การเรียนรู้และกิจกรรมสร้างจิตสำนึก', 'การมีส่วนร่วมของบุคลากร'], goal: 'ทุกคนเข้าใจและร่วมเป็นส่วนหนึ่งของสำนักงานสีเขียว' },
    { intro: 'ใช้ทรัพยากรอย่างรู้คุณค่า ลดการใช้พลังงาน และเพิ่มประสิทธิภาพในการทำงาน', highlights: ['การใช้ไฟฟ้า น้ำ และเชื้อเพลิง', 'การใช้กระดาษและวัสดุสำนักงาน', 'การติดตามการใช้ทรัพยากร'], goal: 'ลดการใช้ทรัพยากรและพลังงานอย่างมีประสิทธิภาพ' },
    { intro: 'ลดของเสียตั้งแต่ต้นทาง คัดแยกอย่างถูกต้อง และส่งต่อเพื่อนำกลับมาใช้ประโยชน์', highlights: ['การลดและคัดแยกขยะ', 'การนำวัสดุกลับมาใช้ประโยชน์', 'การจัดการน้ำเสียและของเสียอย่างเหมาะสม'], goal: 'ลดปริมาณของเสียและจัดการอย่างถูกวิธี' },
    { intro: 'ดูแลสถานที่ทำงานให้น่าอยู่ ปลอดภัย และเอื้อต่อสุขภาพของบุคลากร', highlights: ['สภาพแวดล้อมภายในสำนักงาน', 'การเตรียมพร้อมและความปลอดภัย', 'การดูแลสุขภาพในการทำงาน'], goal: 'สร้างสภาพแวดล้อมที่ดีและส่งเสริมความปลอดภัยของทุกคน' },
    { intro: 'คำนึงถึงผลกระทบต่อสิ่งแวดล้อมในการเลือกซื้อสินค้าและจัดจ้างบริการ', highlights: ['แนวทางการจัดซื้อและจัดจ้าง', 'สินค้าและบริการที่เป็นมิตรกับสิ่งแวดล้อม', 'หลักฐานและการติดตามผู้ให้บริการ'], goal: 'สนับสนุนการใช้สินค้าและบริการที่ลดผลกระทบต่อสิ่งแวดล้อม' },
    { intro: 'ติดตาม ทบทวน และพัฒนาการดำเนินงานสำนักงานสีเขียวอย่างต่อเนื่อง', highlights: ['การติดตามผลการดำเนินงาน', 'การทบทวนและประเมินผล', 'การปรับปรุงเพื่อความต่อเนื่อง'], goal: 'รักษามาตรฐานและพัฒนาสำนักงานสีเขียวอย่างยั่งยืน' }
  ];
  const byId = id => document.getElementById(id);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, className, action) => {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };

  function normalizeRoute(parameters) {
    const result = {};
    for (const key of ['folder', 'file', 'q', 'page']) {
      const value = parameters && parameters[key];
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string') throw new Error('ลิงก์หน้านี้ไม่ถูกต้อง กรุณากลับหน้าแรก');
      if (key === 'page') {
        if (value !== 'about') throw new Error('ไม่พบหน้าที่ต้องการ กรุณากลับหน้าแรก');
        result.page = value;
      } else if (key === 'q') {
        const query = value.trim().normalize('NFC');
        if (query.length > 120) throw new Error('คำค้นหาในลิงก์ยาวเกินไป');
        if (query) result.q = query;
      } else {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error('รหัสในลิงก์ไม่ถูกต้อง กรุณากลับหน้าแรก');
        result[key] = value;
      }
    }
    if (Object.keys(result).length > 1) throw new Error('ลิงก์ระบุหลายหน้าพร้อมกัน กรุณากลับหน้าแรก');
    return result;
  }

  function routeUrl(route) {
    const query = new URLSearchParams(route).toString();
    return appUrl + (query ? '?' + query : '');
  }

  function setRouteLink(link, route) {
    link.href = routeUrl(route);
    link.target = '_self';
    link.dataset.route = JSON.stringify(route);
    if (!link.routeBound) {
      link.routeBound = true;
      link.addEventListener('click', function (event) {
        // Keep normal browser actions: copy address, open in a new tab, middle click.
        if (!historyReady || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault();
        navigate(JSON.parse(link.dataset.route));
      });
    }
    return link;
  }

  function routeLink(text, className, route) {
    return setRouteLink(node('a', className, text), route);
  }

  function commitRoute(route, mode) {
    const changed = JSON.stringify(route) !== JSON.stringify(currentRoute);
    if (changed) {
      listingOptions.type = 'all';
      listingOptions.sort = 'name';
      byId('fileTypeFilter').value = 'all';
      byId('fileSort').value = 'name';
    }
    currentRoute = route;
    byId('sharePanel').hidden = true;
    byId('shareUrl').value = routeUrl(route);
    byId('copyPageButton').disabled = !appUrl;
    if (historyReady && mode !== 'none' && (changed || mode === 'replace')) {
      window.history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', routeUrl(route));
    }
  }

  function navigate(parameters, mode) {
    try {
      const route = normalizeRoute(parameters);
      if (route.page === 'about') showAbout(mode);
      else if (route.file) openFile(route.file, mode);
      else if (route.folder) openFolder(route.folder, mode);
      else if (route.q) search(route.q, mode);
      else loadDashboard(mode);
    } catch (error) {
      ++state.request;
      prepareView('invalid');
      byId('viewTitle').textContent = 'ไม่พบหน้าที่ต้องการ';
      byId('viewDescription').textContent = 'กลับหน้าแรกเพื่อเลือกหมวดหรือค้นหาเอกสาร';
      showError(error);
      byId('copyPageButton').disabled = true;
    }
  }

  function showParent(route, text) {
    setRouteLink(byId('parentLink'), route);
    byId('parentLink').textContent = '← ' + text;
    byId('parentLink').hidden = false;
  }

  async function copyPageLink() {
    const value = routeUrl(currentRoute || {});
    byId('shareUrl').value = value;
    byId('sharePanel').hidden = false;
    byId('shareStatus').textContent = 'คัดลอกลิงก์ในช่องนี้เพื่อส่งต่อ';
    byId('shareUrl').focus();
    byId('shareUrl').select();
    try {
      await navigator.clipboard.writeText(value);
      if (byId('shareUrl').value === value) byId('shareStatus').textContent = 'คัดลอกลิงก์แล้ว พร้อมส่งต่อได้เลย';
    } catch (error) {
      // Keep the link selectable when clipboard permission is unavailable.
      if (byId('shareUrl').value === value) byId('shareStatus').textContent = 'เลือกข้อความไว้แล้ว กด Ctrl+C หรือแตะค้างเพื่อคัดลอก';
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    byId('workspace').setAttribute('aria-busy', String(busy));
    byId('loadingPanel').hidden = !busy;
    byId('refreshButton').disabled = busy;
    byId('retryButton').disabled = busy;
    byId('loadMoreButton').disabled = busy;
    byId('fileTypeFilter').disabled = busy;
    byId('fileSort').disabled = busy;
    byId('resetFilters').disabled = busy;
  }

  function showError(error) {
    setBusy(false);
    if (!byId('catalogUpdated').getAttribute('datetime')) byId('catalogUpdated').textContent = 'ยังโหลดสารบัญเอกสารไม่ได้';
    state.token = null;
    byId('pagination').hidden = true;
    byId('errorMessage').textContent = error && error.code === 'CATALOG_NOT_CONFIGURED' ?
      'เว็บไซต์ยังไม่มีสารบัญเอกสาร กรุณาติดต่อผู้ดูแลระบบเพื่อเชื่อมต่อข้อมูล แล้วกดโหลดข้อมูลใหม่' :
      error && error.message ? error.message : 'เกิดข้อผิดพลาด กรุณาลองใหม่';
    byId('errorPanel').hidden = false;
    if (!navigationCategories.length && !navigationLoading) {
      byId('categoryNavigation').textContent = '';
      byId('navigationError').hidden = false;
    }
  }

  function showCatalogUpdated(data) {
    if (!data || !data.generatedAt) return;
    const updated = new Date(data.generatedAt);
    if (Number.isNaN(updated.getTime())) return;
    byId('catalogUpdated').textContent = 'สารบัญปรับปรุงล่าสุด ' + new Intl.DateTimeFormat('th-TH', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok'
    }).format(updated) + ' น.';
    byId('catalogUpdated').setAttribute('datetime', updated.toISOString());
  }

  // Ignore responses from previous views, including errors arriving out of order.
  function request(method, args, render) {
    const requestId = ++state.request;
    byId('errorPanel').hidden = true;
    setBusy(true);
    try {
      Promise.resolve(catalogClient.request(method, args))
        .then(function (data) {
          if (requestId !== state.request) return;
          try {
            render(data);
            showCatalogUpdated(data);
            setBusy(false);
          } catch (error) { showError(error); }
        })
        .catch(function (error) {
          if (requestId === state.request) showError(error);
        });
    } catch (error) { showError(error); }
  }

  function prepareView(view) {
    state.view = view;
    state.token = null;
    state.items = [];
    state.selectedId = null;
    setExpanded(false);
    byId('documentLayout').classList.remove('has-preview');
    byId('previewPanel').hidden = true;
    byId('previewFrameWrap').textContent = '';
    byId('imageGallery').hidden = true;
    byId('imageGalleryList').textContent = '';
    byId('imageGallerySummary').textContent = '';
    galleryCards.clear();
    byId('previewFallbackLink').removeAttribute('href');
    byId('wordSection').hidden = true;
    byId('wordList').textContent = '';
    byId('wordList').hidden = true;
    byId('wordToggle').setAttribute('aria-expanded', 'false');
    byId('workspace').removeAttribute('data-category');
    activeCategory = null;
    categoryCrumbs = [];
    byId('categoryOverview').hidden = true;
    updateNavigation();
    byId('parentLink').hidden = true;
    byId('documentLayout').classList.remove('single-document');
    byId('filePageLink').hidden = view === 'file';
    const dashboard = view === 'dashboard';
    const about = view === 'about';
    byId('aboutPage').hidden = !about;
    byId('aboutTeaser').hidden = !dashboard;
    byId('refreshButton').hidden = about;
    byId('dashboardHero').hidden = !dashboard;
    byId('energyChartArea').hidden = !dashboard;
    byId('viewDescription').hidden = dashboard;
    byId('browserPanel').hidden = dashboard || about;
    byId('listingControls').hidden = !['folder', 'search'].includes(view);
    byId('listingStats').textContent = '';
    byId('listingUpdated').textContent = '';
    byId('fileList').textContent = '';
    byId('fileTableWrap').hidden = true;
    byId('emptyPanel').hidden = true;
    byId('pagination').hidden = true;
    byId('warningPanel').hidden = true;
    byId('resultSummary').textContent = '';
    byId('sectionEyebrow').textContent = dashboard ? 'ENERGY OVERVIEW' : 'DOCUMENT LIBRARY';
    renderBreadcrumbs([]);
    byId('breadcrumbNav').hidden = dashboard;
  }

  function showAbout(mode) {
    ++state.request; // A slow document response must not replace this static page.
    commitRoute({ page: 'about' }, mode);
    prepareView('about');
    byId('searchInput').value = '';
    byId('errorPanel').hidden = true;
    setBusy(false);
    byId('sectionEyebrow').textContent = 'OUR GREEN JOURNEY';
    byId('viewTitle').textContent = 'เกี่ยวกับสำนักงานสีเขียว';
    byId('viewDescription').textContent = 'คณะสิ่งแวดล้อม มหาวิทยาลัยเกษตรศาสตร์';
    byId('breadcrumbs').appendChild(node('li', '', 'เกี่ยวกับสำนักงานสีเขียว'));
    document.title = 'เกี่ยวกับสำนักงานสีเขียว | Green Office ENVI';
    byId('viewTitle').focus({ preventScroll: true });
    loadNavigation();
  }

  function loadDashboard(mode) {
    commitRoute({}, mode);
    prepareView('dashboard');
    byId('searchInput').value = '';
    byId('viewTitle').textContent = 'การใช้พลังงาน';
    byId('viewDescription').textContent = '';
    document.title = 'หน้าแรก | Green Office ENVI 2569';
    request('getDashboardData', [], function (data) {
      ['categoryCount', 'topicCount', 'indicatorCount'].forEach(function (key) {
        byId(key).textContent = data.criteria[key];
      });
      byId('footerYear').textContent = data.app.year;
      navigationCategories = data.categories;
      ++navigationRequest;
      navigationLoading = false;
      renderNavigation();
      byId('warningPanel').textContent = (data.warnings || []).join('\n');
      byId('warningPanel').hidden = !(data.warnings || []).length;
    });
  }

  function loadNavigation() {
    if (navigationLoading) return;
    if (navigationCategories.length) { renderNavigation(); return; }
    const requestId = ++navigationRequest;
    navigationLoading = true;
    byId('navigationError').hidden = true;
    byId('categoryNavigation').textContent = 'กำลังโหลดเมนู…';
    function failed() {
      if (requestId !== navigationRequest) return;
      navigationLoading = false;
      byId('categoryNavigation').textContent = '';
      byId('navigationError').hidden = false;
    }
    try {
      Promise.resolve(catalogClient.request('getDashboardData', [])).then(function (data) {
        if (requestId !== navigationRequest) return;
        navigationLoading = false;
        navigationCategories = data.categories;
        renderNavigation();
        renderCategoryOverview();
        showCatalogUpdated(data);
      }).catch(failed);
    } catch (error) { failed(); }
  }

  function renderNavigation() {
    const menu = byId('categoryNavigation');
    menu.textContent = '';
    byId('navigationError').hidden = true;
    navigationCategories.forEach(function (category) {
      const available = category.available && category.id;
      const link = available ? routeLink('', 'sidebar-link', { folder: category.id }) : node('span', 'sidebar-link unavailable');
      link.setAttribute('data-category', category.number);
      link.setAttribute('title', category.title + (available ? '' : ' · ' + (category.issue || 'ไม่พร้อมใช้งาน')));
      if (!available) link.setAttribute('aria-disabled', 'true');
      const icon = node('span', 'sidebar-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.appendChild(categoryIcon(category.number));
      const label = node('span', 'sidebar-link-copy');
      label.append(node('strong', '', category.name), node('span', '', category.title));
      link.append(icon, label);
      menu.appendChild(link);
    });
    updateNavigation();
  }

  function updateNavigation() {
    byId('sidebarHome').removeAttribute('aria-current');
    byId('sidebarAbout').removeAttribute('aria-current');
    if (state.view === 'dashboard') byId('sidebarHome').setAttribute('aria-current', 'page');
    if (state.view === 'about') byId('sidebarAbout').setAttribute('aria-current', 'page');
    Array.from(byId('categoryNavigation').children).forEach(function (link) {
      link.removeAttribute('aria-current');
      if (activeCategory && link.getAttribute('data-category') === String(activeCategory)) {
        link.setAttribute('aria-current', state.view === 'folder' && categoryCrumbs.length === 1 ? 'page' : 'location');
      }
    });
  }

  function setCategoryContext(number, crumbs) {
    activeCategory = Number(number) || null;
    categoryCrumbs = crumbs || [];
    updateNavigation();
    renderCategoryOverview();
  }

  function renderCategoryOverview() {
    const guide = categoryGuides[activeCategory - 1];
    const visible = state.view === 'folder' && categoryCrumbs.length === 1 && !!guide;
    byId('categoryOverview').hidden = !visible;
    if (!visible) return;
    const category = navigationCategories.find(entry => Number(entry.number) === activeCategory);
    byId('categoryBadge').textContent = activeCategory;
    byId('categoryBannerTitle').textContent = category ? category.title : categoryCrumbs[0].name;
    byId('categoryIntro').textContent = guide.intro;
    byId('categoryHighlights').textContent = '';
    guide.highlights.forEach(text => byId('categoryHighlights').appendChild(node('li', '', text)));
    byId('categoryGoal').textContent = guide.goal;
    byId('categoryIllustration').replaceChildren(categoryIcon(activeCategory));
  }

  function categoryIcon(number) {
    const paths = [
      'M8 3H5v18h14V3h-3M9 2h6v4H9zM8 13l3 3 5-6',
      'M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0ZM7 10h10M7 14h6',
      'm13 2-9 12h7l-1 8 10-13h-7l1-7',
      'm8 5 3-3 4 6M8 5l-1 4 4-1M18 9l4 5-4 5M22 14h-7M13 21H6l-3-6M6 21l-2-5 5 1',
      'm12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3ZM12 8v8M8 12h8',
      'M5 7h14l2 14H3L5 7ZM8 8V5a4 4 0 0 1 8 0v3M8 14l3 3 5-6',
      'M20 3C9 2 3 7 5 14c2 6 9 7 13 1 3-4 2-8 2-12ZM3 22l13-13M8 16l-1-5M12 12l5-1'
    ];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[number - 1] || paths[6]);
    svg.appendChild(path);
    return svg;
  }

  function renderBreadcrumbs(crumbs) {
    const list = byId('breadcrumbs');
    list.textContent = '';
    const home = node('li');
    home.appendChild(routeLink('หน้าแรก', '', {}));
    list.appendChild(home);
    crumbs.forEach(function (crumb, index) {
      const entry = node('li');
      if (index === crumbs.length - 1) {
        const current = node('span', '', crumb.name);
        current.setAttribute('aria-current', 'page');
        entry.appendChild(current);
      } else {
        entry.appendChild(routeLink(crumb.name, '', { folder: crumb.id }));
      }
      list.appendChild(entry);
    });
  }

  function openFolder(folderId, mode) {
    commitRoute({ folder: folderId }, mode);
    state.folderId = folderId;
    prepareView('folder');
    byId('viewTitle').textContent = 'เอกสารและโฟลเดอร์';
    byId('viewDescription').textContent = 'กำลังอ่านรายการในโฟลเดอร์';
    loadPage(false);
  }

  function search(query, mode) {
    query = query.trim().normalize('NFC');
    if (!query) { byId('searchInput').focus(); return; }
    commitRoute({ q: query }, mode);
    state.query = query;
    byId('searchInput').value = query;
    prepareView('search');
    byId('viewTitle').textContent = 'ผลการค้นหา';
    byId('viewDescription').textContent = 'คำค้นหา: ' + query;
    renderBreadcrumbs([{ name: 'ผลการค้นหา' }]);
    showParent({}, 'กลับทุกหมวด');
    document.title = 'ค้นหา ' + query + ' | Green Office ENVI 2569';
    loadPage(false);
  }

  function openFile(fileId, mode) {
    commitRoute({ file: fileId }, mode);
    prepareView('file');
    byId('viewTitle').textContent = 'เอกสารหลักฐาน';
    byId('viewDescription').textContent = 'กำลังเปิดเอกสาร';
    request('getFileDetails', [fileId], function (data) {
      state.items = [data.item];
      byId('workspace').setAttribute('data-category', data.folder.categoryNumber || '');
      setCategoryContext(data.folder.categoryNumber, data.breadcrumbs);
      byId('viewTitle').textContent = data.item.name;
      byId('viewDescription').textContent = data.folder.path;
      document.title = data.item.name + ' | Green Office ENVI 2569';
      renderBreadcrumbs(data.breadcrumbs.concat([{ name: data.item.name }]));
      showParent({ folder: data.folder.id }, 'กลับโฟลเดอร์ ' + data.folder.name);
      renderLibrary();
      byId('documentLayout').classList.add('single-document');
      if (state.selectedId) byId('fileTableWrap').hidden = true;
      if (isWord(data.item)) {
        byId('wordList').hidden = false;
        byId('wordToggle').setAttribute('aria-expanded', 'true');
        byId('wordToggle').textContent = '− ซ่อนไฟล์ Word (1)';
      }
      byId('resultSummary').textContent = 'เอกสารจาก ' + data.folder.path;
      byId('viewTitle').focus({ preventScroll: true });
    });
  }

  function restart() {
    if (state.view === 'about') showAbout('none');
    else if (state.view === 'folder') openFolder(state.folderId, 'none');
    else if (state.view === 'search') search(state.query, 'none');
    else if (state.view === 'file') openFile(currentRoute.file, 'none');
    else loadDashboard(state.view === 'invalid' ? 'replace' : 'none');
  }

  async function refreshCatalog() {
    if (state.busy) return;
    const requestId = ++state.request;
    ++navigationRequest;
    navigationLoading = false;
    byId('errorPanel').hidden = true;
    setBusy(true);
    try {
      await catalogClient.refresh();
      navigationCategories = [];
      if (requestId !== state.request) {
        // Navigation can change while a refresh is in flight. Update its menu
        // from the same new snapshot without restarting the user's current page.
        loadNavigation();
        return;
      }
      restart();
      if (['folder', 'file', 'search'].includes(state.view)) loadNavigation();
    } catch (error) {
      if (requestId === state.request) showError(error);
    }
  }

  function loadPage(append) {
    const searching = state.view === 'search';
    const token = append ? state.token : null;
    if (append && (state.busy || !token)) return;
    request(searching ? 'searchDrive' : 'getFolderContents', [searching ? state.query : state.folderId, token, { ...listingOptions }], function (data) {
      if (!searching) {
        byId('workspace').setAttribute('data-category', data.folder.categoryNumber || '');
      setCategoryContext(data.folder.categoryNumber, data.breadcrumbs);
        byId('viewTitle').textContent = data.folder.name;
        byId('viewDescription').textContent = data.folder.path;
        renderBreadcrumbs(data.breadcrumbs);
        const parent = data.breadcrumbs[data.breadcrumbs.length - 2];
        showParent(parent ? { folder: parent.id } : {}, parent ? 'กลับโฟลเดอร์ ' + parent.name : 'กลับทุกหมวด');
        document.title = data.folder.name + ' | Green Office ENVI 2569';
      }
      if (!append) state.items = [];
      const seen = new Set(state.items.map(item => item.kind + ':' + item.id));
      const hiddenNames = !searching && data.folder ? (HIDDEN_ITEMS[data.folder.categoryNumber] || []) : [];
      const added = data.items.filter(function (item) {
        const key = item.kind + ':' + item.id;
        if (seen.has(key)) return false;
        seen.add(key);
        if (hiddenNames.includes(item.name)) return false;
        return true;
      });
      state.items.push(...added);
      state.token = data.nextPageToken || null;
      renderLibrary();
      if (listingOptions.type === 'word') {
        byId('wordList').hidden = false;
        byId('wordToggle').setAttribute('aria-expanded', 'true');
        byId('wordToggle').textContent = '− ซ่อนไฟล์ Word (' + state.items.filter(isWord).length + ')';
      }
      if (data.counts) {
        const labels = { folder: 'โฟลเดอร์', pdf: 'PDF', image: 'รูปภาพ', word: 'Word', other: 'ไฟล์อื่น ๆ' };
        byId('listingStats').textContent = 'ทั้งหมด ' + data.counts.all + ' รายการใน' + (searching ? 'ผลการค้นหานี้' : 'โฟลเดอร์นี้') +
          Object.keys(labels).filter(key => data.counts[key]).map(key => ' · ' + labels[key] + ' ' + data.counts[key]).join('');
      }
      byId('listingUpdated').textContent = data.latestUpdatedAt ? 'รายการทั้งหมดแก้ไขล่าสุด ' + new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok'
      }).format(new Date(data.latestUpdatedAt)) + ' น.' : '';
      const wordCount = state.items.filter(isWord).length;
      byId('resultSummary').textContent = 'แสดง ' + state.items.length +
        (Number.isInteger(data.totalItems) ? ' จาก ' + data.totalItems : '') + ' รายการ' +
        (wordCount && byId('wordList').hidden ? ' · ไฟล์ Word ' + wordCount + ' รายการอยู่ในส่วนแสดงเพิ่มเติม' : '');
      byId('emptyPanel').hidden = state.items.length !== 0;
      byId('emptyTitle').textContent = state.token ? 'ยังไม่พบรายการในช่วงที่อ่านแล้ว' : (searching ? 'ไม่พบผลการค้นหา' : 'โฟลเดอร์นี้ยังว่าง');
      byId('emptyMessage').textContent = state.token ? 'กดปุ่มด้านล่างเพื่ออ่านข้อมูลต่อ' : (searching ? 'ลองใช้คำค้นหาอื่น หรือตรวจสอบชื่อเอกสาร' : 'เอกสารใหม่จะแสดงหลังจากสารบัญปรับปรุงแล้ว');
      if (!state.items.length && listingOptions.type !== 'all') {
        byId('emptyTitle').textContent = 'ไม่พบรายการประเภทที่เลือก';
        byId('emptyMessage').textContent = 'เลือกประเภทอื่น หรือกดล้างตัวกรองเพื่อดูรายการทั้งหมด';
      }
      byId('pagination').hidden = !state.token;
      byId('paginationMessage').textContent = searching ? 'ยังมีผลการค้นหาเพิ่มเติม' : 'ยังมีรายการเพิ่มเติม';
      byId('loadMoreButton').textContent = 'แสดงรายการเพิ่มเติม';
    });
  }

  function changeListing() {
    if (state.busy || !['folder', 'search'].includes(state.view)) return;
    listingOptions.type = byId('fileTypeFilter').value;
    listingOptions.sort = byId('fileSort').value;
    // Clear old previews and cursors before requesting the newly filtered collection.
    restart();
  }

  function trustedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(url.hostname) &&
        !url.username && !url.password && !url.port ? url.href : null;
    } catch (error) { return null; }
  }

  function isWord(item) {
    return item.kind !== 'folder' && (item.typeLabel === 'Word' ||
      /(?:msword|vnd\.openxmlformats-officedocument\.wordprocessingml|vnd\.ms-word)/i.test(item.mimeType || '') ||
      /\.(docx?|docm|dotx?|dotm)$/i.test(item.name));
  }

  function mediaType(item) {
    if (item.kind === 'folder' || isWord(item)) return null;
    if (item.mimeType === 'application/pdf' || item.typeLabel === 'PDF' || /\.pdf$/i.test(item.name)) return 'pdf';
    if (/^image\//.test(item.mimeType || '') || /\.(jpe?g|png|heic|heif|gif|webp|bmp|tiff?)$/i.test(item.name)) return 'image';
    return null;
  }

  function previewUrl(item) {
    if (!mediaType(item) || !/^[A-Za-z0-9_-]{1,200}$/.test(item.id)) return null;
    const original = trustedUrl(item.url);
    if (!original) return null;
    const source = new URL(original);
    if (source.hostname !== 'drive.google.com') return null;
    const preview = new URL('https://drive.google.com/file/d/' + encodeURIComponent(item.id) + '/preview');
    const resourceKey = source.searchParams.get('resourcekey');
    if (resourceKey) preview.searchParams.set('resourcekey', resourceKey);
    return preview.href;
  }

  function previewItems() {
    const galleryIds = new Set(galleryItems().map(item => item.id));
    return state.items.filter(item => previewUrl(item) && !galleryIds.has(item.id)).sort((a, b) =>
      (mediaType(a) === 'pdf' ? 0 : 1) - (mediaType(b) === 'pdf' ? 0 : 1));
  }

  function galleryItems() {
    if (state.view !== 'folder') return [];
    const images = state.items.filter(item => mediaType(item) === 'image' && previewUrl(item));
    return images.length > 1 ? images : [];
  }

  function renderGallery(images) {
    byId('imageGallery').hidden = images.length === 0;
    byId('imageGallerySummary').textContent = images.length ? 'แสดงแล้ว ' + images.length + ' รูป · กดที่รูปเพื่อเปิดดูขนาดใหญ่' : '';
    images.forEach(function (item, index) {
      // Keep loaded thumbnails when another page is appended.
      if (galleryCards.has(item.id)) return;
      const card = node('article', 'gallery-card');
      const link = routeLink('', 'gallery-link', { file: item.id });
      link.setAttribute('aria-label', 'เปิดภาพขนาดใหญ่: ' + item.name);
      const picture = node('div', 'gallery-picture');
      const image = node('img', 'gallery-thumbnail');
      image.alt = ''; // The link and visible caption already name this image.
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
      image.setAttribute('referrerpolicy', 'no-referrer');
      const thumbnail = new URL('https://drive.google.com/thumbnail');
      thumbnail.searchParams.set('id', item.id);
      thumbnail.searchParams.set('sz', 'w800');
      const resourceKey = new URL(previewUrl(item)).searchParams.get('resourcekey');
      if (resourceKey) thumbnail.searchParams.set('resourcekey', resourceKey);
      const fallback = node('span', 'gallery-image-fallback', 'โหลดภาพย่อไม่สำเร็จ กดเพื่อเปิดภาพขนาดใหญ่');
      fallback.hidden = true;
      image.addEventListener('error', function () {
        image.hidden = true;
        fallback.hidden = false;
      });
      image.src = thumbnail.href;
      picture.append(image, fallback);
      const caption = node('div', 'gallery-caption');
      caption.append(node('span', 'gallery-number', 'รูปที่ ' + (index + 1)),
        node('h4', 'gallery-title', item.name), node('span', 'gallery-open', 'ดูภาพขนาดใหญ่ →'));
      link.append(picture, caption);
      card.appendChild(link);
      galleryCards.set(item.id, card);
      byId('imageGalleryList').appendChild(card);
    });
  }

  function setExpanded(expanded) {
    state.expanded = expanded;
    byId('documentLayout').classList.toggle('expanded', expanded);
    byId('expandPreviewButton').textContent = expanded ? 'ย่อกลับ' : 'ขยาย';
    byId('expandPreviewButton').setAttribute('aria-expanded', String(expanded));
  }

  function updatePreviewNavigation() {
    const items = previewItems();
    const index = items.findIndex(item => item.id === state.selectedId);
    byId('previousPreviewButton').disabled = index <= 0;
    byId('nextPreviewButton').disabled = index < 0 || index >= items.length - 1;
    byId('previewPosition').textContent = 'ไฟล์ ' + (index + 1) + ' จาก ' + items.length + ' ที่เปิดดูได้';
    byId('fileList').querySelectorAll('.preview-select').forEach(function (entry) {
      entry.setAttribute('data-selected', String(entry.dataset.fileId === state.selectedId));
    });
  }

  function selectPreview(item, moveFocus) {
    const url = previewUrl(item);
    if (!url) return;
    if (state.selectedId !== item.id) {
      state.selectedId = item.id;
      const frame = node('iframe', 'preview-frame');
      frame.title = 'ตัวอย่าง ' + item.name;
      frame.src = url;
      frame.setAttribute('allow', 'fullscreen');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      byId('previewFrameWrap').replaceChildren(frame);
      byId('previewTitle').textContent = item.name;
      byId('previewType').textContent = mediaType(item) === 'pdf' ? 'PDF DOCUMENT' : 'IMAGE GALLERY';
      byId('previewFallbackLink').href = trustedUrl(item.url);
      setRouteLink(byId('filePageLink'), { file: item.id });
      byId('previewPanel').hidden = false;
      byId('documentLayout').classList.add('has-preview');
    }
    updatePreviewNavigation();
    if (moveFocus) {
      byId('previewTitle').focus({ preventScroll: true });
      byId('previewPanel').scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }

  function stepPreview(direction) {
    const items = previewItems();
    const index = items.findIndex(item => item.id === state.selectedId);
    if (items[index + direction]) selectPreview(items[index + direction], true);
  }

  function renderLibrary() {
    byId('fileList').textContent = '';
    byId('wordList').textContent = '';
    const images = galleryItems();
    const galleryIds = new Set(images.map(item => item.id));
    const libraryItems = state.items.filter(item => !galleryIds.has(item.id));
    libraryItems.forEach(renderItem);
    const wordCount = state.items.filter(isWord).length;
    byId('wordSection').hidden = wordCount === 0;
    byId('wordToggle').textContent = (byId('wordList').hidden ? '＋ แสดง' : '− ซ่อน') + 'ไฟล์ Word (' + wordCount + ')';
    byId('fileTableWrap').hidden = libraryItems.length === wordCount;
    renderGallery(images);
    const previews = previewItems();
    if (state.selectedId && !previews.some(item => item.id === state.selectedId)) {
      state.selectedId = null;
      setExpanded(false);
      byId('previewPanel').hidden = true;
      byId('previewFrameWrap').textContent = '';
      byId('previewFallbackLink').removeAttribute('href');
    }
    if (!state.selectedId && previews.length) selectPreview(previews[0], false);
    else if (state.selectedId) updatePreviewNavigation();
    byId('documentLayout').classList.toggle('has-preview', !!state.selectedId);
  }

  function renderItem(item) {
    const folder = item.kind === 'folder';
    const previewable = !!previewUrl(item);
    const row = node('div', 'file-card' + (folder ? ' folder-card' : ''));
    const title = node('div', 'file-title-cell');
    const label = item.typeLabel || 'ไฟล์อื่น ๆ';
    const iconClass = folder ? 'folder' : label === 'PDF' ? 'pdf' :
      /Docs|Word/.test(label) ? 'document' : /Sheets|Excel/.test(label) ? 'spreadsheet' :
      /JPG|JPEG|PNG|HEIC|HEIF/.test(label) ? 'image' : '';
    const iconText = folder ? '↳' : iconClass === 'document' ? 'DOC' :
      iconClass === 'spreadsheet' ? 'XLS' : iconClass === 'image' ? 'IMG' : label === 'PDF' ? 'PDF' : 'FILE';
    const icon = node('span', 'file-icon ' + iconClass, iconText);
    icon.setAttribute('aria-hidden', 'true');
    const nameWrap = node('div', 'file-name-wrap');
    const name = folder ? routeLink(item.name, 'file-name', { folder: item.id }) :
      previewable ? routeLink(item.name, 'file-name preview-select', { file: item.id }) : node('span', 'file-name', item.name);
    if (previewable) {
      name.dataset.fileId = item.id;
      name.setAttribute('data-selected', String(item.id === state.selectedId));
    }
    nameWrap.appendChild(name);
    nameWrap.appendChild(node('span', 'file-path', item.path || ''));
    title.append(icon, nameWrap);
    const typeCell = node('span', 'type-label', label);
    const date = new Date(item.updatedAt);
    const dateCell = node('span', 'file-date', item.updatedAt && !Number.isNaN(date.getTime()) ?
      'แก้ไข ' + new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(date) : '—');
    const meta = node('div', 'file-meta');
    meta.append(typeCell, dateCell);
    nameWrap.appendChild(meta);
    const action = node('div', 'file-action');
    if (folder) action.appendChild(node('span', 'file-arrow', '→'));
    else if (previewable) action.appendChild(node('span', 'inline-hint', 'เปิดหน้าเอกสาร'));
    else {
      const url = trustedUrl(item.url);
      if (url) {
        const link = node('a', 'button button-outline', 'เปิดใน Drive ↗');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', 'เปิด ' + item.name + ' ใน Drive (แท็บใหม่)');
        action.appendChild(link);
      } else action.appendChild(node('span', 'type-label', 'ไม่พบลิงก์ที่เปิดได้'));
    }
    row.append(title, action);
    byId(isWord(item) ? 'wordList' : 'fileList').appendChild(row);
  }

  document.addEventListener('DOMContentLoaded', function () {
    // A query-based route works at both a custom domain and /repository/ on Pages.
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    appUrl = url.href;
    historyReady = !!(window.history && window.history.pushState);
    setRouteLink(byId('homeButton'), {});
    setRouteLink(byId('dashboardLink'), {});
    setRouteLink(byId('sidebarHome'), {});
    setRouteLink(byId('sidebarAbout'), { page: 'about' });
    setRouteLink(byId('aboutTeaserLink'), { page: 'about' });
    setRouteLink(byId('aboutGoalsLink'), { file: '1G6Ye599TUpZqgWmo-nJceeyoocG_woBf' });
    setRouteLink(byId('aboutTeamLink'), { file: '1KTAOQguACJ6Ds41X_YZrgCVXzx0951Dv' });
    setRouteLink(byId('aboutGoalsFolder'), { folder: '15UhQtkAUINMVNyZCsaTPoQxgiF50Mfsp' });
    setRouteLink(byId('aboutTeamFolder'), { folder: '1HkaJK2F0y4eGHKBq876XuhC-nGNaW7Og' });
    for (const [button, target] of Object.entries({
      jumpOverview: 'aboutOverview', jumpPolicy: 'aboutPolicy', jumpTeam: 'aboutTeam',
      jumpJourney: 'aboutJourney', jumpAward: 'aboutAward', jumpDocuments: 'aboutDocuments'
    })) {
      byId(button).addEventListener('click', function () {
        byId(target).focus({ preventScroll: true });
        byId(target).scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    }
    byId('navigationRetry').addEventListener('click', loadNavigation);
    byId('skipLink').addEventListener('click', function (event) {
      event.preventDefault();
      byId('mainContent').focus({ preventScroll: true });
      byId('mainContent').scrollIntoView({ behavior: 'auto', block: 'start' });
    });
    byId('copyPageButton').addEventListener('click', copyPageLink);
    byId('refreshButton').addEventListener('click', refreshCatalog);
    byId('retryButton').addEventListener('click', refreshCatalog);
    byId('loadMoreButton').addEventListener('click', () => loadPage(true));
    byId('fileTypeFilter').value = listingOptions.type;
    byId('fileSort').value = listingOptions.sort;
    byId('fileTypeFilter').addEventListener('change', changeListing);
    byId('fileSort').addEventListener('change', changeListing);
    byId('resetFilters').addEventListener('click', function () {
      byId('fileTypeFilter').value = 'all';
      byId('fileSort').value = 'name';
      changeListing();
    });
    byId('previousPreviewButton').addEventListener('click', () => stepPreview(-1));
    byId('nextPreviewButton').addEventListener('click', () => stepPreview(1));
    byId('expandPreviewButton').addEventListener('click', function () {
      setExpanded(!state.expanded);
      byId('previewPanel').scrollIntoView({ behavior: 'auto', block: 'start' });
    });
    byId('wordToggle').addEventListener('click', function () {
      byId('wordList').hidden = !byId('wordList').hidden;
      byId('wordToggle').setAttribute('aria-expanded', String(!byId('wordList').hidden));
      byId('wordToggle').textContent = (byId('wordList').hidden ? '＋ แสดง' : '− ซ่อน') + 'ไฟล์ Word (' + state.items.filter(isWord).length + ')';
    });
    byId('searchForm').addEventListener('submit', function (event) {
      if (!historyReady) return;
      event.preventDefault();
      search(byId('searchInput').value);
    });
    function readLocation(mode) {
      const parameters = {};
      const query = new URLSearchParams(window.location.search);
      for (const key of ['folder', 'file', 'q', 'page']) {
        if (query.has(key)) parameters[key] = query.getAll(key).length === 1 ? query.get(key) : null;
      }
      navigate(parameters, mode);
      if (['folder', 'file', 'search'].includes(state.view)) loadNavigation();
    }
    window.addEventListener('popstate', function () { readLocation('none'); });
    try {
      catalogClient = window.GreenOfficeCatalog.createClient({ url: new URL('data/catalog.json', appUrl).href });
      readLocation('replace');
    } catch (error) {
      byId('catalogUpdated').textContent = 'ยังโหลดสารบัญเอกสารไม่ได้';
      showError(error);
    }
  });
})();
