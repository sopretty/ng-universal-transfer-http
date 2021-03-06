import { ApplicationRef, Inject, Injectable, Optional, PLATFORM_ID } from '@angular/core';
import { HttpEvent, HttpHandler, HttpHeaders, HttpInterceptor, HttpRequest, HttpResponse } from '@angular/common/http';
import { TransferState, makeStateKey, StateKey } from '@angular/platform-browser';
import { isPlatformServer } from '@angular/common';

import { Observable } from 'rxjs/Observable';
import { of } from 'rxjs/observable/of';
import { _throw } from 'rxjs/observable/throw';
import { from } from 'rxjs/observable/from';
import { first, filter, flatMap, map, tap, defaultIfEmpty } from 'rxjs/operators';
import { mergeStatic } from 'rxjs/operators/merge';

import * as createHash from 'create-hash/browser';

import { NG_UNIVERSAL_TRANSFER_HTTP_CONFIG } from '../../tokens';

/**
 * Response interface
 */
interface TransferHttpResponse {
    body?: any | null;
    headers?: { [k: string]: string[] };
    status?: number;
    statusText?: string;
    url?: string;
}

/**
 * Server state interface
 */
interface ServerStateData {
    id: number,
    reqKey: string
}

@Injectable()
export class TransferHttpCacheInterceptor implements HttpInterceptor {
    // private property to store cache activation status
    private _isCacheActive: boolean;
    // private property to store unique id of the key
    private _id: number;
    // private property to store serve state data store key
    private _serverStateDataStoreKey: StateKey<ServerStateData[]>;
    // private property to store last id store key
    private _lastIdStoreKey: StateKey<number>;

    /**
     * Class constructor
     *
     * @param {ApplicationRef} _appRef
     * @param {TransferState} _transferState
     * @param {Object} _platformId
     * @param {boolean} _prodMode
     */
    constructor(private _appRef: ApplicationRef, private _transferState: TransferState,
                @Inject(PLATFORM_ID) private _platformId: Object,
                @Optional() @Inject(NG_UNIVERSAL_TRANSFER_HTTP_CONFIG) private _prodMode: boolean) {
        this._isCacheActive = true;
        this._id = 0;
        this._serverStateDataStoreKey = makeStateKey<ServerStateData[]>('server_state_data');
        this._lastIdStoreKey = makeStateKey<number>('server_state_last_id');

        // Stop using the cache if the application has stabilized, indicating initial rendering is complete
        // or if we are in development mode.
        mergeStatic(
            of(this._prodMode)
                .pipe(
                    filter(_ => _ !== null && _ !== true),
                    tap(_ =>
                        console.log('TransferHttpCacheModule is in the development mode. ' +
                            'Enable the production mode with Server Side Rendering.')
                    )
                ),
            this._appRef.isStable
                .pipe(
                    filter(_ => !!_),
                )
        )
            .pipe(
                first()
            )
            .subscribe(_ => this._isCacheActive = false);
    }

    /**
     * Interceptor process
     *
     * @param {HttpRequest<any>} req
     * @param {HttpHandler} next
     *
     * @return {Observable<HttpEvent<any>>}
     */
    intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        return of(
            of(this._isCacheActive)
        )
            .pipe(
                flatMap(isCacheActive =>
                    mergeStatic(
                        isCacheActive
                            .pipe(
                                filter(_ => !_),
                                flatMap(_ => next.handle(req)
                                    .pipe(
                                        tap(__ => this._cleanServerState())
                                    )
                                )
                            ),
                        isCacheActive
                            .pipe(
                                filter(_ => !!_),
                                flatMap(_ => this._transferStateProcess(req, next))
                            )
                    )
                )
            );
    }

    /**
     * Function to clean all data in server state
     *
     * @private
     */
    private _cleanServerState(): void {
        mergeStatic(
            this._getLastId(false)
                .pipe(
                    tap(_ => this._transferState.remove(this._lastIdStoreKey))
                ),
            this._getServerStateData(false)
                .pipe(
                    tap(_ =>
                        _.forEach(__ =>
                            this._transferState.remove(makeStateKey<TransferHttpResponse>(this._createHash(`${__.reqKey}_${__.id}`)))
                        )
                    ),
                    tap(_ => this._transferState.remove(this._serverStateDataStoreKey))
                )
        )
            .subscribe(
                undefined,
                e => {
                    throw(e);
                }
            );
    }

    /**
     * Transfer state process
     *
     * @param {HttpRequest<any>} req
     * @param {HttpHandler} next
     *
     * @returns {Observable<HttpEvent<any>>}
     *
     * @private
     */
    private _transferStateProcess(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        return this._createKey(req)
            .pipe(
                flatMap(storeKey =>
                    of(of(this._transferState.hasKey(storeKey)))
                        .pipe(
                            flatMap(hasKey =>
                                mergeStatic(
                                    this._hasKeyProcess(hasKey, storeKey),
                                    this._hasNotKeyProcess(req, next, hasKey, storeKey)
                                )
                            )
                        )
                ),
            );
    }

    /**
     * Creates transfer state key's store
     *
     * @param {HttpRequest<any>} req
     *
     * @returns {Observable<StateKey<TransferHttpResponse>>}
     *
     * @private
     */
    private _createKey(req: HttpRequest<any>): Observable<StateKey<TransferHttpResponse>> {
        this._id++;

        return of(of(isPlatformServer(this._platformId)))
            .pipe(
                flatMap(isServer =>
                    mergeStatic(
                        isServer
                            .pipe(
                                filter(_ => !!_),
                                flatMap(_ => this._serverKey(req))
                            ),
                        isServer
                            .pipe(
                                filter(_ => !_),
                                flatMap(_ => this._clientKey(req))
                            )
                    )
                )
            );
    }

    /**
     * Function to get state data and create client key for current request
     *
     * @param {HttpRequest<any>} req
     *
     * @return {Observable<StateKey<TransferHttpResponse>>}
     *
     * @private
     */
    private _clientKey(req: HttpRequest<any>): Observable<StateKey<TransferHttpResponse>> {
        return of(this._createHash(JSON.stringify(req)))
            .pipe(
                flatMap(reqKey =>
                    this._getServerStateData()
                        .pipe(
                            flatMap(_ => from(_)),
                            filter(_ => _.reqKey === reqKey),
                            defaultIfEmpty(undefined),
                            flatMap(_ =>
                                !!_ ?
                                    of(_) :
                                    _throw(new Error('Request missing in server state data'))
                            ),
                            flatMap(serverState =>
                                this._getLastId()
                                    .pipe(
                                        flatMap(_ =>
                                            !_ || this._id > _ ?
                                                _throw(new Error('Wrong id for server state data')) :
                                                of(this._id)
                                        ),
                                        map(_ => _ === serverState.id ? _ : serverState.id),
                                        map(id => this._createHash(`${reqKey}_${id}`)),
                                        map(key => makeStateKey<TransferHttpResponse>(key))
                                    )
                            )
                        )
                )
            );
    }

    /**
     * Function to get last id from server
     *
     * @param {boolean} throwError
     *
     * @return {Observable<number>}
     *
     * @private
     */
    private _getLastId(throwError: boolean = true): Observable<number> {
        return of(this._lastIdStoreKey)
            .pipe(
                flatMap(storeKey =>
                    of(of(this._transferState.hasKey(storeKey)))
                        .pipe(
                            flatMap(hasKey =>
                                mergeStatic(
                                    hasKey
                                        .pipe(
                                            filter(_ => !_),
                                            flatMap(_ =>
                                                of(throwError)
                                                    .pipe(
                                                        filter(__ => !!__),
                                                        flatMap(__ => _throw(new Error('Missing server state last id')))
                                                    )
                                            )
                                        ),
                                    hasKey
                                        .pipe(
                                            filter(_ => !!_),
                                            map(_ => this._transferState.get(storeKey, 0))
                                        )
                                )
                            )
                        )
                )
            )
    }

    /**
     * Function to get server state data
     *
     * @param {boolean} throwError
     *
     * @return {Observable<ServerStateData[]>}
     *
     * @private
     */
    private _getServerStateData(throwError: boolean = true): Observable<ServerStateData[]> {
        return of(this._serverStateDataStoreKey)
            .pipe(
                flatMap(storeKey =>
                    of(of(this._transferState.hasKey(storeKey)))
                        .pipe(
                            flatMap(hasKey =>
                                mergeStatic(
                                    hasKey
                                        .pipe(
                                            filter(_ => !_),
                                            flatMap(_ =>
                                                of(throwError)
                                                    .pipe(
                                                        filter(__ => !!__),
                                                        flatMap(__ => _throw(new Error('Missing server state data')))
                                                    )
                                            )
                                        ),
                                    hasKey
                                        .pipe(
                                            filter(_ => !!_),
                                            map(_ => this._transferState.get(storeKey, [] as ServerStateData[]))
                                        )
                                )
                            )
                        )
                )
            )
    }

    /**
     * Function to create server key and store state data for current request
     *
     * @param {HttpRequest<any>} req
     *
     * @return {Observable<StateKey<TransferHttpResponse>>}
     *
     * @private
     */
    private _serverKey(req: HttpRequest<any>): Observable<StateKey<TransferHttpResponse>> {
        return of(this._createHash(JSON.stringify(req)))
            .pipe(
                tap(reqKey => this._storeServerStateData(reqKey)),
                map(reqKey => this._createHash(`${reqKey}_${this._id}`)),
                map(key => makeStateKey<TransferHttpResponse>(key))
            );
    }

    /**
     * Function to store server state data
     *
     * @param {string} reqKey
     *
     * @private
     */
    private _storeServerStateData(reqKey: string): void {
        of(this._serverStateDataStoreKey)
            .pipe(
                flatMap(storeKey =>
                    of(of(this._transferState.hasKey(storeKey)))
                        .pipe(
                            flatMap(hasKey =>
                                mergeStatic(
                                    hasKey
                                        .pipe(
                                            filter(_ => !_),
                                            map(_ => [] as ServerStateData[])
                                        ),
                                    hasKey
                                        .pipe(
                                            filter(_ => !!_),
                                            map(_ => this._transferState.get(storeKey, [] as ServerStateData[])),
                                            flatMap(serverStateData =>
                                                !!serverStateData.find(_ => _.reqKey === reqKey) ?
                                                    _throw(new Error('Request already stored in server state data')) :
                                                    of(serverStateData)
                                            )
                                        )
                                )
                            ),
                            tap(_ => this._transferState.set(this._lastIdStoreKey, this._id))
                        )
                )
            )
            .subscribe(
                serverStateData => this._transferState.set(this._serverStateDataStoreKey, serverStateData.concat({
                        id: this._id,
                        reqKey
                    })
                ),
                e => {
                    throw(e);
                }
            );
    }

    /**
     * Process when key exists in transfer state
     *
     * @param {Observable<boolean>} hasKey
     * @param {StateKey<TransferHttpResponse>} storeKey
     *
     * @returns {Observable<HttpEvent<any>>}
     *
     * @private
     */
    private _hasKeyProcess(hasKey: Observable<boolean>, storeKey: StateKey<TransferHttpResponse>): Observable<HttpEvent<any>> {
        return hasKey
            .pipe(
                filter(_ => !!_),
                map(_ => this._transferState.get(storeKey, {} as TransferHttpResponse)),
                map((response: TransferHttpResponse) => new HttpResponse<any>({
                    body: response.body,
                    headers: new HttpHeaders(response.headers),
                    status: response.status,
                    statusText: response.statusText,
                    url: response.url,
                }))
            );
    }

    /**
     * Process when key doesn't exist in transfer state
     *
     * @param {HttpRequest<any>} req
     * @param {HttpHandler} next
     * @param {Observable<boolean>} hasKey
     * @param {StateKey<TransferHttpResponse>} storeKey
     *
     * @returns {Observable<HttpEvent<any>>}
     *
     * @private
     */
    private _hasNotKeyProcess(req: HttpRequest<any>,
                              next: HttpHandler,
                              hasKey: Observable<boolean>,
                              storeKey: StateKey<TransferHttpResponse>): Observable<HttpEvent<any>> {
        return hasKey
            .pipe(
                filter(_ => !_),
                flatMap(_ =>
                    next.handle(req)
                        .pipe(
                            tap((event: HttpEvent<any>) =>
                                of(event)
                                    .pipe(
                                        filter(evt => evt instanceof HttpResponse)
                                    )
                                    .subscribe((evt: HttpResponse<any>) => this._transferState.set(storeKey, {
                                        body: evt.body,
                                        headers: this._getHeadersMap(evt.headers),
                                        status: evt.status,
                                        statusText: evt.statusText,
                                        url: evt.url!,
                                    }))
                            )
                        )
                )
            )
    }

    /**
     * Creates Headers Map
     *
     * @param {HttpHeaders} headers
     *
     * @return {{[name: string]: string[]}}
     *
     * @private
     */
    private _getHeadersMap(headers: HttpHeaders): { [name: string]: string[] } {
        return headers.keys().reduce((acc, curr) => Object.assign(acc, { [curr]: headers.getAll(curr)! }), {});
    }

    /**
     * Function to create sha256 hash
     *
     * @param data
     *
     * @return {string}
     *
     * @private
     */
    private _createHash(data: any): string {
        return createHash('sha256').update(data).digest('hex');
    }
}
