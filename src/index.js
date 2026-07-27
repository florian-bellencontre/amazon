import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format, parse } from 'date-fns'
import { fr } from 'date-fns/locale'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'

const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://www.amazon.fr'
const orderHistoryUrl = `${baseUrl}/gp/css/order-history`
const desktopUserAgent =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
// Amazon renamed the email input on the signin page from #ap_email to
// #ap_email_login ; keep both so the konnector survives an A/B rollback
const emailInputSelector = '#ap_email_login, #ap_email'
const signOutLinkSelector = 'a[href*="/gp/flex/sign-out.html?"]'
const orderCardSelector = '.order-card.js-order-card'
const ORDERS_PER_PAGE = 10
// fallback path only : how often to checkpoint with saveBills
const SAVE_BILLS_EVERY_PAGES = 5
// the orders pages served to fetch() are empty shells (cards are rendered by
// the page javascript), so pages are loaded in hidden same-origin iframes.
// Two of them keep memory usage acceptable in the mobile webview.
const IFRAME_CONCURRENCY = 2
const POPOVER_FETCH_CONCURRENCY = 8
// orders more recent than this can still receive new documents (credit notes,
// late invoices) : never skip them even when they are already saved
const KNOWN_ORDERS_RECHECK_DAYS = 90
// TODO use a flag to change this value
let FORCE_FETCH_ALL = false
const vendor = 'amazon'

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index], index)
      }
    })
  )
  return results
}

class AmazonContentScript extends ContentScript {
  async setUserAgent() {
    this.log('info', '📍️ setUserAgent starts')
    await this.bridge.call('setUserAgent', desktopUserAgent)
  }

  async navigateToLoginForm() {
    this.log('info', '📍️ navigateToLoginForm starts')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker('#nav-greeting-name'),
      this.waitForElementInWorker('#nav-link-accountList')
    ])
    if (await this.isElementInWorker('#nav-greeting-name')) {
      await this.setUserAgent()
      await this.evaluateInWorker(function reloadWindow() {
        window.location.reload()
      })
      await this.runInWorkerUntilTrue({ method: 'checkUserAgentReload' })
    }
    await this.runInWorker('dismissCookieBanner')
    if (await this.isElementInWorker(signOutLinkSelector)) {
      this.log('info', 'Already authenticated, no need to reach the login form')
      return
    }
    // #nav-link-accountList is not a link anymore, the signin url lives in an
    // anchor inside of it
    await this.runInWorker('clickSignInLink')
    await Promise.race([
      this.waitForElementInWorker(emailInputSelector),
      this.waitForElementInWorker('#nav-item-signout')
    ])
  }

  // P
  async ensureAuthenticated({ account }) {
    this.log('info', '📍️ Starting ensureAuthenticated')
    await this.setUserAgent()
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    if (!(await this.isElementInWorker(emailInputSelector))) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    this.log('debug', 'Authenticated : ' + authenticated)
    if (authenticated) {
      return true
    } else {
      let credentials = await this.getCredentials()
      if (credentials && credentials.email && credentials.password) {
        try {
          this.log('info', 'Got credentials, trying autologin')
          await this.tryAutoLogin(credentials)
        } catch (err) {
          this.log('debug', 'autoLogin error ' + err.message)
          await this.showLoginFormAndWaitForAuthentication()
        }
      } else {
        await this.showLoginFormAndWaitForAuthentication()
        if (!this.store?.email || !this.store?.password) {
          throw new Error(
            'One or both credentials interception went wrong, aborting execution.'
          )
        }
      }
    }
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '📍️ ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const isConnected = await this.isElementInWorker(signOutLinkSelector)
    if (isConnected) {
      await this.runInWorker('click', signOutLinkSelector)
      await this.waitForElementInWorker(emailInputSelector)
    }
  }

  // W
  async checkAuthenticated() {
    this.log('info', '📍️ checkAuthenticated starts')
    const mailInput = document.querySelector(emailInputSelector)
    const passwordInput = document.querySelector('#ap_password')
    if (mailInput) {
      await this.setListenerLogin()
    }
    if (passwordInput) {
      await this.setListenerPassword()
    }
    // After a login amazon may show an "add a phone number/email" interstitial,
    // dismiss it automatically as this method is polled during authentication
    const fixupSkipLink = document.querySelector(
      '#ap-account-fixup-phone-skip-link'
    )
    if (fixupSkipLink) {
      this.log('info', 'Dismissing account fixup interstitial')
      fixupSkipLink.click()
    }
    const result = Boolean(document.querySelector(signOutLinkSelector))
    this.log('debug', 'Authentification detection : ' + result)
    return result
  }

  // P
  async tryAutoLogin(credentials) {
    this.log('info', '📍️ tryAutoLogin starts')
    await this.waitForElementInWorker(emailInputSelector)
    await this.waitForElementInWorker('#continue')

    // Enter login
    await this.runInWorker('fillText', emailInputSelector, credentials.email)
    // Click continue: now a span#continue containing the real submit input
    await this.clickAndWait(
      '#continue input.a-button-input, input[id="continue"]',
      '#ap_password'
    )

    // Enter password
    await this.runInWorker('fillText', '#ap_password', credentials.password)

    // Click check box (if present)
    await this.runInWorker('checkingBox')

    // Click Login
    await this.runInWorker('click', 'input#signInSubmit')

    // The account may require a TOTP or captcha step : detect it and hand the
    // webview over to the user instead of failing
    await Promise.race([
      this.waitForElementInWorker(signOutLinkSelector, { timeout: 30 * 1000 }),
      this.waitForElementInWorker('#auth-mfa-otpcode', { timeout: 30 * 1000 })
    ])
    if (!(await this.runInWorker('checkAuthenticated'))) {
      this.log(
        'info',
        'Autologin needs a user action (TOTP/captcha), showing worker'
      )
      await this.showLoginFormAndWaitForAuthentication()
    }
  }

  findAndSendCredentials() {
    this.log('info', '📍️ findAndSendCredentials starts')
    const emailField = document.querySelector(emailInputSelector)
    const passwordField = document.querySelector('#ap_password')
    this.log('debug', 'Executing findAndSendCredentials')
    if (emailField && emailField.value) {
      this.sendToPilot({
        email: emailField.value
      })
    }
    if (passwordField && passwordField.value) {
      this.sendToPilot({
        password: passwordField.value
      })
    }
    return true
  }

  // P
  async showLoginFormAndWaitForAuthentication() {
    this.log('info', '📍️ showLoginFormAndWaitForAuthentication start')
    await this.bridge.call('setWorkerState', {
      visible: true
    })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    this.unblockWorkerInteractions()
    await this.bridge.call('setWorkerState', {
      visible: false
    })
  }

  // W
  async setListenerLogin() {
    const loginField = document.querySelector(emailInputSelector)
    if (loginField) {
      loginField.addEventListener(
        'change',
        this.findAndSendCredentials.bind(this)
      )
    }
  }

  // W
  async setListenerPassword() {
    const passwordField = document.querySelector('#ap_password')
    if (passwordField) {
      passwordField.addEventListener(
        'change',
        this.findAndSendCredentials.bind(this)
      )
    }
  }

  // W
  async checkingBox() {
    const checkbox = document.querySelector('[name="rememberMe"]')
    // Checking the 'Stay connected' checkbox when loaded
    if (checkbox && checkbox.checked == false) {
      this.log('debug', 'Checking the RememberMe box')
      checkbox.click()
    }
  }

  // W
  async dismissCookieBanner() {
    const rejectButton = document.querySelector('#sp-cc-rejectall-link')
    if (rejectButton) {
      this.log('info', 'Dismissing cookie banner')
      rejectButton.click()
    }
    return true
  }

  // W
  async clickSignInLink() {
    const signInLink = document.querySelector('a[href*="/ap/signin"]')
    if (signInLink) {
      signInLink.click()
      return true
    }
    // fallback : the old direct click on the nav element
    const accountList = document.querySelector('#nav-link-accountList')
    if (accountList) {
      accountList.click()
    }
    return true
  }

  // P
  async fetch(context) {
    this.log('info', '📍️ Starting fetch')
    const distanceInDays = await this.handleContextInfos(context)
    if (this.store?.email && this.store?.password) {
      this.log('info', 'Saving credentials...')
      const userCredentials = {
        email: this.store.email,
        password: this.store.password
      }
      await this.saveCredentials(userCredentials)
    }
    await this.goto(orderHistoryUrl)
    await this.waitForElementInWorker('#time-filter')
    let periods = await this.runInWorker('getYears', '#time-filter')
    if (!FORCE_FETCH_ALL) {
      // If false, we just need the last period depending on the distanceInDays value
      if (distanceInDays <= 30) {
        this.log(
          'info',
          'lastExecution under or equals 30 days, fetching the last 30 days period'
        )
        periods = ['last30']
      }
      if (distanceInDays > 30 && distanceInDays < 90) {
        this.log(
          'info',
          'lastExecution between 30 and 90 days, fetching the last 3 months period'
        )
        periods = ['months-3']
      }
    }
    this.log('debug', 'Periods : ' + periods)
    const knownOrderIds = await this.getKnownOrderIds()
    const knownSkipMaxDate = format(
      new Date(Date.now() - KNOWN_ORDERS_RECHECK_DAYS * 24 * 60 * 60 * 1000),
      'yyyy-MM-dd'
    )
    for (const period of periods) {
      this.log('info', `Fetching period ${period}`)
      let periodBills
      try {
        periodBills = await this.fetchPeriodWithIframes(period, {
          knownOrderIds,
          knownSkipMaxDate
        })
      } catch (err) {
        this.log(
          'warn',
          `Fast period extraction failed (${err.message}), falling back to page navigation`
        )
        await this.fetchPeriodWithNavigation(period, context)
        continue
      }
      if (periodBills.length > 0) {
        await this.saveBills(periodBills, {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'other_invoice'
        })
      }
    }
  }

  // P
  async getKnownOrderIds() {
    // Orders whose bill is already saved can be skipped entirely : no invoice
    // popover fetch and above all no saveBills call, which spares the launcher
    // its costly existing files index rebuilds
    try {
      const bills = await this.queryAll({
        toDefinition: () => ({ doctype: 'io.cozy.bills' })
      })
      const orderIds = new Set()
      for (const bill of bills || []) {
        const billVendor = String(bill.vendor || '').toLowerCase()
        if (billVendor.startsWith('amazon') && bill.vendorRef) {
          orderIds.add(String(bill.vendorRef).split('_')[0])
        }
      }
      this.log('info', `Found ${orderIds.size} orders already saved`)
      return Array.from(orderIds)
    } catch (err) {
      this.log('warn', `Could not list already saved bills: ${err.message}`)
      return []
    }
  }

  // P
  async fetchPeriodWithIframes(period, { knownOrderIds, knownSkipMaxDate }) {
    const ordersCount = await this.runInWorker('fetchOrdersCount', period)
    this.log('info', `Found ${ordersCount} orders for period ${period}`)
    if (ordersCount === 0) {
      return []
    }
    const pagesCount = Math.ceil(ordersCount / ORDERS_PER_PAGE)
    const rawBills = await this.runInWorker('extractPeriodBills', {
      period,
      pagesCount,
      knownOrderIds,
      knownSkipMaxDate
    })
    if (!Array.isArray(rawBills)) {
      throw new Error('extractPeriodBills did not answer')
    }
    return this.splitMultiInvoiceBills(rawBills)
  }

  // P : previous navigation based flow, kept as fallback
  async fetchPeriodWithNavigation(period, context) {
    this.log('info', `📍️ fetchPeriodWithNavigation starts for ${period}`)
    await this.navigateToOrdersPage(period, 0)
    const ordersCount = await this.runInWorker('getOrdersCount')
    this.log('info', `Found ${ordersCount} orders for period ${period}`)
    if (ordersCount === 0) {
      return
    }
    const pagesCount = Math.ceil(ordersCount / ORDERS_PER_PAGE)
    // The launcher rebuilds its whole existing files index on every
    // saveBills call : save every few pages instead of every page to limit
    // those rebuilds while keeping regular checkpoints.
    let pendingBills = []
    for (let page = 0; page < pagesCount; page++) {
      this.log('info', `Fetching bills for page ${page + 1}/${pagesCount}`)
      if (page > 0) {
        await this.navigateToOrdersPage(period, page * ORDERS_PER_PAGE)
      }
      await this.runInWorkerUntilTrue({ method: 'waitForOrdersLoading' })
      const rawBills = await this.runInWorker('extractPageBills')
      pendingBills.push(...this.splitMultiInvoiceBills(rawBills || []))
      const isLastPage = page === pagesCount - 1
      const isCheckpoint = (page + 1) % SAVE_BILLS_EVERY_PAGES === 0
      if (pendingBills.length > 0 && (isLastPage || isCheckpoint)) {
        await this.saveBills(pendingBills, {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'other_invoice'
        })
        pendingBills = []
      }
    }
  }

  // P
  splitMultiInvoiceBills(bills) {
    const result = []
    for (const bill of bills) {
      if (Array.isArray(bill.fileurl)) {
        this.log('debug', 'fileurl is an Array, splitting bill')
        let billNumber = 1
        for (const url of bill.fileurl) {
          const oneBill = {
            ...bill
          }
          oneBill.fileurl = url
          oneBill.filename = oneBill.filename.replace(
            '.pdf',
            `_facture${billNumber}.pdf`
          )
          oneBill.vendorRef = `${oneBill.vendorRef}_${billNumber}`
          result.push(oneBill)
          billNumber++
        }
      } else {
        result.push(bill)
      }
    }
    return result
  }

  // P
  async navigateToOrdersPage(period, startIndex) {
    this.log(
      'info',
      `📍️ navigateToOrdersPage starts - ${period} startIndex ${startIndex}`
    )
    // The year dropdown is a native select now : navigating with the
    // timeFilter url parameter is more reliable than emulating the dropdown.
    // Remove the current counter element first so we cannot match the previous
    // page's DOM while the new one is loading.
    await this.runInWorker('deleteElement', '.num-orders')
    await this.goto(
      `${orderHistoryUrl}?timeFilter=${period}&startIndex=${startIndex}`
    )
    await this.waitForElementInWorker('.num-orders')
  }

  async handleContextInfos(context) {
    this.log('info', '📍️ handleContextInfos starts')
    const { trigger } = context
    const isFirstJob =
      !trigger.current_state?.last_failure &&
      !trigger.current_state?.last_success

    const isLastJobError =
      !isFirstJob &&
      trigger.current_state?.last_failure ===
        trigger.current_state?.last_execution

    const hasLastExecution = Boolean(trigger.current_state?.last_execution)
    const distanceInDays = getDateDistanceInDays(
      trigger.current_state?.last_execution
    )
    this.log('debug', `distanceInDays: ${distanceInDays}`)
    if (distanceInDays >= 90 || !hasLastExecution || isLastJobError) {
      this.log('info', '🐢️ Long execution')
      this.log('debug', `isLastJobError: ${isLastJobError}`)
      this.log('debug', `hasLastExecution: ${hasLastExecution}`)
      FORCE_FETCH_ALL = true
    } else {
      this.log('info', '🐇️ Quick execution')
    }
    return distanceInDays
  }

  async checkUserAgentReload() {
    this.log('info', '📍️ checkUserAgentReload starts')
    await waitFor(
      () => {
        if (
          navigator.userAgent === desktopUserAgent &&
          Boolean(document.querySelector('#nav-link-accountList'))
        ) {
          this.log('info', 'userAgent change is successfull')
          return true
        }
        this.log('info', 'userAgent reload not ready yet')
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  // W
  async getYears(selector) {
    this.log('info', '📍️ getYears starts')
    return Array.from(document.querySelectorAll(`${selector} option`))
      .map(el => el.value)
      .filter(period => period.includes('year'))
  }

  // W
  async fetchOrdersCount(period) {
    this.log('info', '📍️ fetchOrdersCount starts')
    const response = await window.fetch(
      `${orderHistoryUrl}?timeFilter=${period}&startIndex=0`,
      { credentials: 'include' }
    )
    if (!response.ok) {
      throw new Error(`orders page fetch failed with status ${response.status}`)
    }
    const doc = new DOMParser().parseFromString(
      await response.text(),
      'text/html'
    )
    const element = doc.querySelector('.num-orders')
    if (!element) {
      throw new Error('num-orders not found in fetched orders page')
    }
    const count = parseInt(element.textContent.trim(), 10)
    return isNaN(count) ? 0 : count
  }

  // W
  async extractPeriodBills(options) {
    this.log('info', '📍️ extractPeriodBills starts')
    const {
      period,
      pagesCount,
      knownOrderIds = [],
      knownSkipMaxDate = '0000-00-00'
    } = options
    const known = new Set(knownOrderIds)
    let skippedKnown = 0
    const pageIndexes = Array.from(
      { length: pagesCount },
      (unused, index) => index
    )
    const ordersPerPage = await mapWithConcurrency(
      pageIndexes,
      IFRAME_CONCURRENCY,
      async pageIndex => {
        const pageOrders = await this.scrapeOrdersPageInIframe(
          period,
          pageIndex * ORDERS_PER_PAGE
        )
        return pageOrders.filter(order => {
          const isKnown =
            known.has(order.base.vendorRef) &&
            order.base.date < knownSkipMaxDate
          if (isKnown) {
            skippedKnown++
          }
          return !isKnown
        })
      }
    )
    const orders = ordersPerPage.flat()
    if (skippedKnown > 0) {
      this.log('info', `${skippedKnown} orders already saved, skipping them`)
    }
    const bills = []
    await mapWithConcurrency(orders, POPOVER_FETCH_CONCURRENCY, async order => {
      if (!order.popoverUrl) {
        this.log(
          'info',
          `No invoice popover for order ${order.base.vendorRef}, skipping`
        )
        return
      }
      const invoiceUrls = await this.fetchInvoiceUrls(order.popoverUrl)
      if (invoiceUrls === null) {
        this.log(
          'warn',
          `Could not fetch invoice links for order ${order.base.vendorRef}, skipping`
        )
        return
      }
      if (invoiceUrls.length === 0) {
        this.log(
          'info',
          'Found an order with no bill attached to it, jumping this bill'
        )
        return
      }
      bills.push(this.makeBill(order.base, invoiceUrls))
    })
    return bills
  }

  // W
  async scrapeOrdersPageInIframe(period, startIndex) {
    this.log(
      'info',
      `📍️ scrapeOrdersPageInIframe starts - ${period} startIndex ${startIndex}`
    )
    const iframe = document.createElement('iframe')
    iframe.style.cssText =
      'position:absolute;left:-9999px;top:-9999px;width:1200px;height:900px;border:0'
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`iframe load timed out - startIndex ${startIndex}`)
            ),
          30 * 1000
        )
        iframe.addEventListener('load', () => {
          clearTimeout(timer)
          resolve()
        })
        iframe.src = `${orderHistoryUrl}?timeFilter=${period}&startIndex=${startIndex}`
        document.body.appendChild(iframe)
      })
      // the cards content is rendered by the page own javascript after load
      await waitFor(
        () => {
          const iframeDocument = iframe.contentDocument
          if (!iframeDocument) {
            return false
          }
          const cards = iframeDocument.querySelectorAll(orderCardSelector)
          if (cards.length === 0) {
            return false
          }
          return Array.from(cards).every(
            card =>
              card.querySelector('.order-header__header-list-item') &&
              card.querySelector('.yohtmlc-order-id')
          )
        },
        {
          interval: 200,
          timeout: {
            milliseconds: 30000,
            message: new TimeoutError(
              `orders page in iframe did not render - startIndex ${startIndex}`
            )
          }
        }
      )
      const orders = []
      for (const card of iframe.contentDocument.querySelectorAll(
        orderCardSelector
      )) {
        const base = this.parseOrderCard(card)
        if (base === null) {
          continue
        }
        orders.push({ base, popoverUrl: this.getInvoicePopoverUrl(card) })
      }
      return orders
    } finally {
      iframe.remove()
    }
  }

  // W
  async waitForOrdersLoading() {
    this.log('info', '📍️ waitForOrdersLoading starts')
    await waitFor(
      () => {
        const foundOrders = document.querySelectorAll(orderCardSelector)
        if (foundOrders.length === 0) {
          return false
        }
        for (const foundOrder of foundOrders) {
          const hasHeader = foundOrder.querySelector(
            '.order-header__header-list-item'
          )
          const hasOrderId = foundOrder.querySelector('.yohtmlc-order-id')
          if (!hasHeader || !hasOrderId) {
            this.log(
              'info',
              'One order card is not loaded yet, waiting for all cards to load properly'
            )
            return false
          }
        }
        return true
      },
      {
        interval: 500,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(
            `waitForOrdersLoading timed out after 30000 ms`
          )
        }
      }
    )
    return true
  }

  // W
  async getOrdersCount() {
    this.log('info', '📍️ getOrdersCount starts')
    let ordersCount
    await waitFor(
      () => {
        const element = document.querySelector('.num-orders')
        if (element && element.textContent.includes('commande')) {
          ordersCount = parseInt(element.textContent.trim(), 10)
          if (isNaN(ordersCount)) {
            ordersCount = 0
          }
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return ordersCount
  }

  // W
  deleteElement(element) {
    // As we loop on the orders pages, every page contains the exact same elements.
    // To avoid matching an element of the previous page while the next one loads,
    // we remove it from the html before navigating.
    const foundElement = document.querySelector(element)
    if (foundElement) {
      foundElement.remove()
    }
    return true
  }

  // W : fallback path, extracts the bills of the currently displayed page
  async extractPageBills() {
    this.log('info', '📍️ extractPageBills starts')
    const cards = Array.from(document.querySelectorAll(orderCardSelector))
    const parsedCards = []
    for (const card of cards) {
      const base = this.parseOrderCard(card)
      if (base !== null) {
        parsedCards.push({ card, base })
      }
    }
    const bills = []
    await mapWithConcurrency(
      parsedCards,
      POPOVER_FETCH_CONCURRENCY,
      async ({ card, base }) => {
        const invoiceUrls = await this.fetchInvoiceUrlsForCard(card)
        if (invoiceUrls === null) {
          this.log(
            'info',
            `No invoice popover for order ${base.vendorRef}, skipping`
          )
          return
        }
        if (invoiceUrls.length === 0) {
          this.log(
            'info',
            'Found an order with no bill attached to it, jumping this bill'
          )
          return
        }
        bills.push(this.makeBill(base, invoiceUrls))
      }
    )
    return bills
  }

  // W
  parseOrderCard(card) {
    const headerItems = card.querySelectorAll('.order-header__header-list-item')
    const dateText = headerItems[0]
      ?.querySelector('.a-size-base')
      ?.textContent.trim()
    const totalText = headerItems[1]
      ?.querySelector('.a-size-base')
      ?.textContent.trim()
    if (!dateText || !totalText) {
      this.log('warn', 'Order card misses date or total, skipping')
      return null
    }
    if (totalText.match(/crédit(s)? audio/g)) {
      this.log('info', 'Found an audiobook, jumping this bill')
      return null
    }
    const amountMatch = totalText.match(/([\d\s\u00a0.,]+)/)
    const currencyMatch = totalText.match(/([^\d\s\u00a0.,]+)/)
    if (!amountMatch) {
      this.log('warn', `Cannot parse amount "${totalText}", skipping`)
      return null
    }
    const amount = parseFloat(
      amountMatch[1].replace(/[\s\u00a0]/g, '').replace(',', '.')
    )
    if (amount === 0) {
      this.log(
        'info',
        'Found a free product, no bill attached to it, jumping this bill'
      )
      return null
    }
    const currency = currencyMatch ? currencyMatch[1] : '€'
    const orderIdText = card.querySelector('.yohtmlc-order-id')?.textContent
    const orderIdMatch = orderIdText && orderIdText.match(/(\d{3}-\d+-\d+)/)
    if (!orderIdMatch) {
      this.log('warn', 'Cannot find order number on card, skipping')
      return null
    }
    const parsedDate = parse(dateText, 'd MMMM yyyy', new Date(), {
      locale: fr
    })
    const billProducts = []
    const seenProducts = new Set()
    const foundProducts = card.querySelectorAll(
      'a[href*="/dp/"], a[href*="/gp/product/"]'
    )
    for (const link of foundProducts) {
      const articleName = link.textContent.trim()
      const href = link.getAttribute('href')
      if (!articleName || seenProducts.has(href)) {
        continue
      }
      seenProducts.add(href)
      billProducts.push({
        articleLink: href.startsWith('http') ? href : baseUrl + href,
        articleName
      })
    }
    return {
      date: format(parsedDate, 'yyyy-MM-dd'),
      amount,
      currency,
      vendorRef: orderIdMatch[1],
      billProducts
    }
  }

  // W
  makeBill(base, invoiceUrls) {
    return {
      vendor: 'amazon.fr',
      date: base.date,
      amount: base.amount,
      currency: base.currency,
      vendorRef: base.vendorRef,
      fileurl: invoiceUrls.length > 1 ? invoiceUrls : invoiceUrls[0],
      filename: `${base.date}_${vendor}_${base.amount}${base.currency}.pdf`,
      billProducts: base.billProducts,
      fileAttributes: {
        metadata: {
          contentAuthor: 'amazon',
          datetime: new Date(base.date),
          datetimeLabel: 'issueDate',
          carbonCopy: true
        }
      }
    }
  }

  // W
  getInvoicePopoverUrl(card) {
    const factureDeclarative = Array.from(
      card.querySelectorAll('span.a-declarative')
    ).find(span => (span.textContent || '').trim().startsWith('Facture'))
    let popoverUrl
    try {
      popoverUrl = JSON.parse(
        factureDeclarative?.getAttribute('data-a-popover')
      )?.url
    } catch (err) {
      popoverUrl = null
    }
    if (!popoverUrl) {
      return null
    }
    return popoverUrl.startsWith('http') ? popoverUrl : baseUrl + popoverUrl
  }

  // W : fetch the invoice links list of an order from its popover ajax url.
  // Returns null when the fetch failed, an array of urls otherwise.
  async fetchInvoiceUrls(popoverUrl) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await window.fetch(popoverUrl, {
          credentials: 'include'
        })
        if (response.ok) {
          const doc = new DOMParser().parseFromString(
            await response.text(),
            'text/html'
          )
          return Array.from(doc.querySelectorAll('a[href*="invoice.pdf"]')).map(
            link => {
              const href = link.getAttribute('href')
              return href.startsWith('http') ? href : baseUrl + href
            }
          )
        }
        this.log(
          'warn',
          `Invoice popover fetch answered ${response.status} (attempt ${
            attempt + 1
          })`
        )
      } catch (err) {
        this.log(
          'warn',
          `Invoice popover fetch failed: ${err.message} (attempt ${
            attempt + 1
          })`
        )
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return null
  }

  // W : fallback path, on the live page the popover ui can be used when the
  // direct ajax fetch fails
  async fetchInvoiceUrlsForCard(card) {
    const popoverUrl = this.getInvoicePopoverUrl(card)
    if (popoverUrl) {
      const invoiceUrls = await this.fetchInvoiceUrls(popoverUrl)
      if (invoiceUrls !== null) {
        return invoiceUrls
      }
    }
    return this.getOrderInvoiceUrls(card)
  }

  // W : last resort, open the popover ui like a user would
  async getOrderInvoiceUrls(card) {
    const factureLink = Array.from(
      card.querySelectorAll('a.a-link-normal')
    ).find(a => (a.textContent || '').trim().startsWith('Facture'))
    if (!factureLink) {
      return null
    }
    const getPopoverIds = () =>
      Array.from(document.querySelectorAll('[id^="a-popover-content-"]')).map(
        el => el.id
      )
    let popoverId = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const idsBefore = getPopoverIds()
      factureLink.click()
      try {
        await waitFor(
          () => {
            if (!popoverId) {
              popoverId = getPopoverIds().find(id => !idsBefore.includes(id))
            }
            if (!popoverId) {
              return false
            }
            const popover = document.getElementById(popoverId)
            if (!popover) {
              return false
            }
            // popover content is loaded asynchronously : ready when it shows
            // either the links list or an error alert
            return Boolean(
              popover.querySelector('ul > li > span > .a-link-normal') ||
                popover.querySelector('.a-icon-alert')
            )
          },
          {
            interval: 500,
            timeout: 15 * 1000
          }
        )
      } catch (err) {
        this.log(
          'warn',
          `Timed out waiting for invoice popover (attempt ${attempt + 1})`
        )
      }
      const popover = popoverId && document.getElementById(popoverId)
      if (popover && !popover.querySelector('.a-icon-alert')) {
        const urls = Array.from(
          popover.querySelectorAll('a[href*="invoice.pdf"]')
        ).map(a => {
          const href = a.getAttribute('href')
          return href.startsWith('http') ? href : baseUrl + href
        })
        this.closePopover()
        return urls
      }
      // If the website did not manage to load the download links it shows an
      // error in the popover. Closing and clicking again usually resolves it.
      this.log(
        'info',
        'Website generated an error when trying to show downloadLinks, retrying ...'
      )
      this.closePopover()
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return []
  }

  // W
  closePopover() {
    // Clicking outside the popover (here the page background) closes it
    const page = document.querySelector('#a-page')
    if (page) {
      page.click()
    }
    const closeButton = document.querySelector(
      '.a-popover:not([style*="display: none"]) .a-button-close'
    )
    if (closeButton) {
      closeButton.click()
    }
  }

  // W
  scrollToTop() {
    this.log('info', 'scrollToTop starts')
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  // P
  async getUserDataFromWebsite() {
    this.log('info', '📍️ Starting getUserDataFromWebsite')
    if (this.store && this.store.email) {
      return {
        sourceAccountIdentifier: this.store.email
      }
    } else {
      let credentials = await this.getCredentials()
      if (credentials && credentials.email) {
        return {
          sourceAccountIdentifier: credentials.email
        }
      } else {
        throw new Error(
          'No credentials were found, cannot give a sourceAccountIdentifier, aborting execution'
        )
      }
    }
  }
}

const connector = new AmazonContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'checkUserAgentReload',
      'getYears',
      'checkingBox',
      'setListenerLogin',
      'setListenerPassword',
      'dismissCookieBanner',
      'clickSignInLink',
      'getOrdersCount',
      'fetchOrdersCount',
      'deleteElement',
      'extractPageBills',
      'extractPeriodBills',
      'waitForOrdersLoading',
      'scrollToTop'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function getDateDistanceInDays(dateString) {
  const distanceMs = Date.now() - new Date(dateString).getTime()
  const days = 1000 * 60 * 60 * 24

  return Math.floor(distanceMs / days)
}
