import Observable from './utils/observable/Observable';
import UrlParser from './Services/UrlParser';
import SilentModeService from './Services/SilentModeService';
import { setHistoryMode } from './utils/configuration/setHistoryMode';
import { setHashMode } from './utils/configuration/setHashMode';
import { downloadDynamicComponents } from './utils/code-splitting/downloadDynamicComponents';
import { isBrowser } from '../utils/index';
import { parseRoutes } from './utils/parsing/parseRoutes';
import { getMatchData } from './utils/parsing/getMatchData';
import { constructUrl } from './utils/path/constructUrl';
import { deleteEdgeSlashes } from './utils/path/deleteEdgeSlashes';
import { getMaxDepth } from './utils/misc/getMaxDepth';

const SSR = !isBrowser();

export default class Router {
  private readonly routes: RouteMatchData[] = [];
  private ignoreEvents = false;
  private silentControl: SilentModeService | null = null;
  private currentUrl = '';

  public beforeEach: RouterHook | null = null;
  public afterEach: RouterHook | null = null;
  public currentMatched = new Observable<RouteMatchData[]>([]);
  public currentRouteData = new Observable<RouteInfoData>({
    params: {},
    query: {},
    name: '',
    fullPath: ''
  });

  constructor(private settings: RouterSettings) {
    if (!settings.mode) {
      this.settings.mode = 'hash';
      console.warn(
        '[Easyroute] Router mode is not defined: fallback to "hash"'
      );
    }
    this.routes = getMatchData(settings.routes);
    !SSR &&
      setTimeout(() => {
        this.setParser();
      }, 0);
    if (SSR && this.mode !== 'history')
      throw new Error('[Easyroute] SSR only works with "history" router mode');
  }

  private setParser() {
    switch (this.mode) {
      case 'silent':
        this.parseRoute(`${window.location.pathname}${window.location.search}`);
        break;
      case 'history':
        setHistoryMode.apply(this);
        break;
      case 'hash':
      default:
        setHashMode.apply(this);
        break;
    }
  }

  private getTo(matched: RouteMatchData[]): RouteMatchData {
    return matched.find(
      (route) => route.nestingDepth === getMaxDepth(matched)
    ) as RouteMatchData;
  }

  private getFrom(): RouteMatchData | null {
    const current: RouteMatchData[] = this.currentMatched.getValue;
    if (!current) return null;
    return (
      current.find((route) => route.nestingDepth === getMaxDepth(current)) ??
      null
    );
  }

  private changeUrl(url: string, doPushState = true): void {
    this.currentUrl = url;
    if (this.mode === 'hash') {
      window.location.hash = url;
    }
    if (this.mode === 'history' && doPushState && !SSR) {
      window.history.pushState(
        {
          url
        },
        url,
        url
      );
    }
  }

  private async runAllIndividualHooks(
    matched: RouteMatchData[],
    to: RouteInfoData,
    from: RouteInfoData | null
  ) {
    for await (const component of matched) {
      const allow = await this.executeBeforeHook(
        to,
        from,
        component.beforeEnter as RouterHook
      );
      if (!allow) {
        return false;
      }
    }
    return true;
  }

  public async parseRoute(url: string, doPushState = true) {
    url = url.replace(/^#/, '');
    const matched = parseRoutes(this.routes, url.split('?')[0]);
    if (!matched) return;
    const to = this.getTo(matched);
    const from = this.getFrom();
    const toRouteInfo = UrlParser.createRouteObject([to], url);
    const fromRouteInfo = from
      ? UrlParser.createRouteObject([from], this.currentUrl)
      : null;
    if (this.mode === 'silent' && !this.silentControl) {
      this.silentControl = new SilentModeService(toRouteInfo);
    }
    if (this.silentControl && doPushState) {
      this.silentControl.appendHistory(toRouteInfo);
    }
    const allowNextGlobal = await this.executeBeforeHook(
      toRouteInfo,
      fromRouteInfo,
      this.beforeEach as RouterHook
    );
    const allowNextLocal = await this.runAllIndividualHooks(
      matched,
      toRouteInfo,
      fromRouteInfo
    );
    const allowNext = allowNextGlobal && allowNextLocal;
    if (!allowNext) return;
    this.changeUrl(
      constructUrl(url, this.base, this.settings.omitTrailingSlash),
      doPushState
    );
    this.currentRouteData.setValue(toRouteInfo);
    this.currentMatched.setValue(await downloadDynamicComponents(matched));
    this.afterHook(toRouteInfo, fromRouteInfo);
  }

  private async executeBeforeHook(
    to: RouteInfoData,
    from: RouteInfoData | null,
    hook: RouterHook
  ) {
    return new Promise(async (resolve) => {
      const next = (command?: HookCommand) => {
        if (command !== null && command !== undefined) {
          if (command === false) resolve(false);
          if (typeof command === 'string') {
            this.parseRoute(command);
            resolve(false);
          }
        } else {
          resolve(true);
        }
      };
      if (!hook) resolve(true);
      else await hook(to, from, next);
    });
  }

  private afterHook(to: RouteInfoData, from: RouteInfoData | null) {
    this.afterEach && this.afterEach(to, from);
  }

  public async push(url: string) {
    this.ignoreEvents = true;
    await this.parseRoute(url);
  }

  public go(howFar: number) {
    if (this.mode !== 'silent') {
      window.history.go(howFar);
    } else {
      this.parseRoute(this.silentControl!.go(howFar), false);
    }
  }

  public back() {
    this.go(-1);
  }

  get mode() {
    return this.settings.mode;
  }

  get base() {
    if (!this.settings.base) return '';
    return deleteEdgeSlashes(this.settings.base) + '/';
  }

  get currentRoute() {
    return this.currentRouteData.getValue;
  }
}
