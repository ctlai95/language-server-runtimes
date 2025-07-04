import {
    CancellationToken,
    DidChangeConfigurationParams,
    ExecuteCommandParams,
    GetConfigurationFromServerParams,
    InitializeError,
    InitializeResult,
    MessageType,
    NotificationFollowupParams,
    NotificationParams,
    RequestHandler,
    ResponseError,
    TextDocumentSyncKind,
    CreateFilesParams,
    DeleteFilesParams,
    RenameFilesParams,
    DidSaveTextDocumentParams,
} from '../../../protocol'
import { Connection } from 'vscode-languageserver/node'
import { LspRouter } from './lspRouter'
import assert from 'assert'
import sinon from 'sinon'
import { PartialInitializeResult, InitializeParams } from '../../../server-interface/lsp'
import { LspServer } from './lspServer'
import { CredentialsType, Logging } from '../../../server-interface'
import { Encoding } from '../../encoding'
import { SERVER_CAPABILITES_CONFIGURATION_SECTION } from './constants'

describe('LspRouter', () => {
    const sandbox = sinon.createSandbox()

    const encoding: Encoding = {
        encode: (value: string) => value,
        decode: (value: string) => value,
    }
    const logging = {
        log: sandbox.stub(),
        debug: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub(),
        info: sandbox.stub(),
    } as Logging
    const lspConnection = stubLspConnection()

    let executeCommandHandler: RequestHandler<ExecuteCommandParams, any | undefined | null, void>
    let initializeHandler: RequestHandler<InitializeParams, PartialInitializeResult, InitializeError>

    let lspRouter: LspRouter

    beforeEach(() => {
        const onInitializeSpy = sandbox.spy(lspConnection, 'onInitialize')
        const onExecuteommandSpy = sandbox.spy(lspConnection, 'onExecuteCommand')
        lspConnection.telemetry.logEvent = sandbox.stub()
        lspConnection.console.log = sandbox.stub()
        lspConnection.console.info = sandbox.stub()
        lspConnection.console.warn = sandbox.stub()

        lspRouter = new LspRouter(lspConnection, 'AWS LSP Standalone', '1.0.0')

        initializeHandler = onInitializeSpy.getCall(0).args[0] as RequestHandler<
            InitializeParams,
            PartialInitializeResult,
            InitializeError
        >
        executeCommandHandler = onExecuteommandSpy.getCall(0).args[0] as RequestHandler<
            ExecuteCommandParams,
            any | undefined | null,
            void
        >
    })

    afterEach(function () {
        sandbox.restore()
    })

    describe('initialize', () => {
        it('should store InitializeParam in a field', () => {
            const initParam = {} as InitializeParams
            initializeHandler(initParam, {} as CancellationToken)
            assert(lspRouter.clientInitializeParams === initParam)
        })
        it('should store workspaceFolders in a field when workspaceFolders specified', () => {
            const workspaceFolders = [{ name: 'test', uri: 'file:///test' }]
            const initParam = {
                workspaceFolders: workspaceFolders,
            } as InitializeParams

            initializeHandler(initParam, {} as CancellationToken)

            assert.deepStrictEqual(lspRouter.getAllWorkspaceFolders(), workspaceFolders)
        })

        it('should store workspaceFolders in a field when rootUri specified', () => {
            const expectedWorkspace = [{ name: 'test', uri: 'file:///test' }]
            const initParam = {
                rootUri: 'file:///test',
            } as InitializeParams

            initializeHandler(initParam, {} as CancellationToken)

            assert.deepStrictEqual(lspRouter.getAllWorkspaceFolders(), expectedWorkspace)
        })

        it('should only log when no workspace folders are found', () => {
            const initParam = {
                processId: null,
                rootUri: null,
                capabilities: {},
                workspaceFolders: [],
            } as InitializeParams

            initializeHandler(initParam, {} as CancellationToken)

            sinon.assert.calledWith(
                lspConnection.console.info as sinon.SinonStub,
                'No workspace folders found in initialization parameters'
            )
        })

        it('should log telemetry event when aws config is missing in InitializeParams', async () => {
            const params: InitializeParams = {
                processId: null,
                rootUri: null,
                capabilities: {},
                initializationOptions: {},
            }

            await initializeHandler(params, {} as CancellationToken)
            // @ts-ignore
            sinon.assert.calledOnce(lspConnection.telemetry.logEvent)
            // @ts-ignore
            sinon.assert.calledOnce(lspConnection.console.log)
        })

        it('should log telemetry event only once when aws config is missing in InitializeParams when multiple servers are present', async () => {
            const params: InitializeParams = {
                processId: null,
                rootUri: null,
                capabilities: {},
                initializationOptions: {},
            }
            lspRouter.servers.push(newServer({}))
            lspRouter.servers.push(newServer({}))

            await initializeHandler(params, {} as CancellationToken)
            // @ts-ignore
            sinon.assert.calledOnce(lspConnection.telemetry.logEvent)
            // @ts-ignore
            sinon.assert.calledOnce(lspConnection.console.log)
        })

        it('should return the default response when no handlers are registered', async () => {
            const result = await initializeHandler({} as InitializeParams, {} as CancellationToken)

            const expected = {
                serverInfo: {
                    name: 'AWS LSP Standalone',
                    version: '1.0.0',
                },
                capabilities: {
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                        save: {
                            includeText: true,
                        },
                    },
                },
            }
            assert.deepStrictEqual(result, expected)
        })

        it('should return the default response when server with no handler is registered', async () => {
            lspRouter.servers.push(newServer({}))
            const result = await initializeHandler({} as InitializeParams, {} as CancellationToken)

            const expected = {
                serverInfo: {
                    name: 'AWS LSP Standalone',
                    version: '1.0.0',
                },
                capabilities: {
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                        save: {
                            includeText: true,
                        },
                    },
                },
            }
            assert.deepStrictEqual(result, expected)
        })

        it('should merge handler results with the default response', async () => {
            const handler1 = () => {
                return {
                    serverInfo: {
                        name: 'Q Inline Completion Server',
                    },
                    capabilities: {
                        completionProvider: { resolveProvider: true },
                        executeCommandProvider: { commands: ['log', 'test'] },
                    },
                }
            }
            const handler2 = () => {
                return Promise.resolve({
                    capabilities: {
                        executeCommandProvider: { commands: ['run'] },
                    },
                    extraField: 'extraValue',
                })
            }

            lspRouter.servers.push(newServer({ initializeHandler: handler1 }))
            lspRouter.servers.push(newServer({ initializeHandler: handler2 }))

            const result = await initializeHandler({} as InitializeParams, {} as CancellationToken)

            const expected: InitializeResult = {
                serverInfo: {
                    name: 'AWS LSP Standalone',
                    version: '1.0.0',
                },
                capabilities: {
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                        save: {
                            includeText: true,
                        },
                    },
                    completionProvider: { resolveProvider: true },
                    executeCommandProvider: { commands: ['run', 'log', 'test'] },
                },
                extraField: 'extraValue',
            }

            assert.deepStrictEqual(result, expected)
        })

        it('should prioritize the response of the handler that comes first', async () => {
            const handler1 = () => {
                return {
                    capabilities: {
                        completionProvider: { resolveProvider: true },
                    },
                }
            }
            const handler2 = () => {
                return Promise.resolve({
                    capabilities: {
                        completionProvider: { resolveProvider: false },
                    },
                })
            }

            lspRouter.servers.push(newServer({ initializeHandler: handler1 }))
            lspRouter.servers.push(newServer({ initializeHandler: handler2 }))

            const result = await initializeHandler({} as InitializeParams, {} as CancellationToken)

            const expected: InitializeResult = {
                serverInfo: {
                    name: 'AWS LSP Standalone',
                    version: '1.0.0',
                },
                capabilities: {
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                        save: {
                            includeText: true,
                        },
                    },
                    completionProvider: { resolveProvider: true },
                },
            }

            assert.deepStrictEqual(result, expected)
        })

        it('should return error if any of the handlers failed', async () => {
            const handler1 = () => {
                return {
                    capabilities: {
                        completionProvider: { resolveProvider: true },
                    },
                }
            }
            const error = new ResponseError(111, 'failed', { retry: false })
            const handler2 = (): Promise<ResponseError<InitializeError>> => {
                return Promise.resolve(error)
            }

            lspRouter.servers.push(newServer({ initializeHandler: handler1 }))
            lspRouter.servers.push(newServer({ initializeHandler: handler2 }))

            const result = await initializeHandler({} as InitializeParams, {} as CancellationToken)

            assert.deepStrictEqual(result, error)
        })

        it('should return error if duplicate server names set', async () => {
            const handlers: any[] = [
                () => ({ serverInfo: { name: 'A' } }),
                () => ({ serverInfo: { name: 'B' } }),
                () => ({ serverInfo: { name: 'A' } }),
                () => ({ serverInfo: { name: 'B' } }),
                () => ({ serverInfo: { name: 'C' } }),
            ]

            handlers.forEach(h => {
                lspRouter.servers.push(newServer({ initializeHandler: h }))
            })

            const result = await initializeHandler({} as InitializeParams, {} as CancellationToken)

            assert(result instanceof ResponseError)
            assert.equal(result.message, 'Duplicate servers defined: A, B')
        })
    })

    describe('executeCommand', () => {
        it('should prioritize the command of the server that comes first', async () => {
            const initHandler1 = () => {
                return {
                    capabilities: {
                        executeCommandProvider: { commands: [] },
                    },
                }
            }
            const initHandler2 = () => {
                return {
                    capabilities: {
                        executeCommandProvider: { commands: ['log', 'test'] },
                    },
                }
            }
            const initHandler3 = () => {
                return {
                    capabilities: {
                        executeCommandProvider: { commands: ['test'] },
                    },
                }
            }

            const servers = [
                newServer({ initializeHandler: initHandler1, executeCommandHandler: () => 'server1' }),
                newServer({ initializeHandler: initHandler2, executeCommandHandler: () => 'server2' }),
                newServer({ initializeHandler: initHandler3, executeCommandHandler: () => 'server3' }),
            ]

            for (const server of servers) {
                lspRouter.servers.push(server)
                await server.initialize({} as InitializeParams, {} as CancellationToken)
            }

            const result = await executeCommandHandler(
                { command: 'test' } as ExecuteCommandParams,
                {} as CancellationToken
            )

            assert.equal(result, 'server2')
        })
    })

    describe('onInitialized', () => {
        it('should send InitializedNotification to all servers', () => {
            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const server1 = newServer({ initializedHandler: spy1 })
            const server2 = newServer({ initializedHandler: spy2 })

            lspRouter.servers = [server1, server2]
            lspRouter.onInitialized({})

            assert(spy1.calledOnce)
            assert(spy2.calledOnce)
        })
    })

    describe('didChangeConfiguration', () => {
        it('should send DidChangeConfigurationNotification to all servers', () => {
            const params: DidChangeConfigurationParams = {
                settings: {},
            }

            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const server1 = newServer({ didChangeConfigurationHandler: spy1 })
            const server2 = newServer({ didChangeConfigurationHandler: spy2 })

            lspRouter.servers = [server1, server2]
            lspRouter.didChangeConfiguration(params)
            assert(spy1.calledWith(params))
            assert(spy2.calledWith(params))
        })
    })

    describe('onCredentialsDeletion', () => {
        it('should send notifyCredentialsDeletion to all servers', () => {
            const params: CredentialsType = 'bearer'

            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const server1 = newServer({ credentialsDeleteHandler: spy1 })
            const server2 = newServer({ credentialsDeleteHandler: spy2 })

            lspRouter.servers = [server1, server2]
            lspRouter.onCredentialsDeletion(params)
            assert(spy1.calledWith(params))
            assert(spy2.calledWith(params))
        })
    })

    describe('handleGetConfigurationFromServer', () => {
        it(`should return the result from initializeResult cache for key: ${SERVER_CAPABILITES_CONFIGURATION_SECTION}`, async () => {
            const initHandler1 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['log'] },
                    },
                }
            }
            const initHandler2 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['log', 'test'] },
                        chatOptions: {
                            quickActions: {
                                quickActionsCommandGroups: [
                                    {
                                        commands: [
                                            {
                                                command: '/help',
                                                description: 'Learn more about Amazon Q',
                                                icon: 'help',
                                            },
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                }
            }
            const initHandler3 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['test'] },
                    },
                }
            }

            const servers = [
                newServer({ initializeHandler: initHandler1 }),
                newServer({ initializeHandler: initHandler2 }),
                newServer({ initializeHandler: initHandler3 }),
            ]

            for (const server of servers) {
                lspRouter.servers.push(server)
                await server.initialize({} as InitializeParams, {} as CancellationToken)
            }

            await initializeHandler({} as InitializeParams, {} as CancellationToken)

            const params: GetConfigurationFromServerParams = { section: SERVER_CAPABILITES_CONFIGURATION_SECTION }
            const result = await lspRouter.getConfigurationFromServer(params, {} as CancellationToken)
            const expectedServerCapabilities = {
                configurationProvider: {
                    sections: ['test', 'log'],
                },
                chatOptions: {
                    quickActions: {
                        quickActionsCommandGroups: [
                            {
                                commands: [
                                    {
                                        command: '/help',
                                        description: 'Learn more about Amazon Q',
                                        icon: 'help',
                                    },
                                ],
                            },
                        ],
                    },
                },
            }
            assert.deepEqual(result, expectedServerCapabilities)
        })

        it('should return the result from the first server that handles the request', async () => {
            const initHandler1 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['log'] },
                    },
                }
            }
            const initHandler2 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['log', 'test'] },
                    },
                }
            }
            const initHandler3 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['test'] },
                    },
                }
            }

            const servers = [
                newServer({ initializeHandler: initHandler1, getServerConfigurationHandler: () => 'server1' }),
                newServer({ initializeHandler: initHandler2, getServerConfigurationHandler: () => 'server2' }),
                newServer({ initializeHandler: initHandler3, getServerConfigurationHandler: () => 'server3' }),
            ]

            for (const server of servers) {
                lspRouter.servers.push(server)
                await server.initialize({} as InitializeParams, {} as CancellationToken)
            }

            const params: GetConfigurationFromServerParams = { section: 'test' }
            const result = await lspRouter.getConfigurationFromServer(params, {} as CancellationToken)
            assert.strictEqual(result, 'server2')
        })

        it('should return undefined if no server handles the request', async () => {
            const initHandler1 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: [] },
                    },
                }
            }
            const initHandler2 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['log', 'test'] },
                    },
                }
            }
            const initHandler3 = () => {
                return {
                    awsServerCapabilities: {
                        configurationProvider: { sections: ['test'] },
                    },
                }
            }

            const servers = [
                newServer({ initializeHandler: initHandler1, getServerConfigurationHandler: () => 'server1' }),
                newServer({ initializeHandler: initHandler2, getServerConfigurationHandler: () => 'server2' }),
                newServer({ initializeHandler: initHandler3, getServerConfigurationHandler: () => 'server3' }),
            ]

            for (const server of servers) {
                lspRouter.servers.push(server)
                await server.initialize({} as InitializeParams, {} as CancellationToken)
            }

            const params: GetConfigurationFromServerParams = { section: 'something' }
            const result = await lspRouter.getConfigurationFromServer(params, {} as CancellationToken)
            assert.strictEqual(result, undefined)
        })
    })

    describe('updateConfiguration', () => {
        it('should send UpdateConfigurationRequest to all server', async () => {
            const updateConfigSpy1 = sandbox.spy()
            const updateConfigSpy2 = sandbox.spy()
            const server1 = newServer({ updateConfigurationHandler: updateConfigSpy1 })
            const server2 = newServer({ updateConfigurationHandler: updateConfigSpy2 })

            const configParams = {
                section: 'aws.testconfig',
                settings: {
                    testSetting: 'value',
                },
            }

            lspRouter.servers = [server1, server2]
            await lspRouter.updateConfiguration(configParams, {} as CancellationToken)

            assert(updateConfigSpy1.calledWith(configParams))
            assert(updateConfigSpy2.calledWith(configParams))
        })

        it('should return null if all servers returned empty response', async () => {
            const server1 = newServer({
                updateConfigurationHandler: () => Promise.resolve(null),
            })
            const server2 = newServer({
                updateConfigurationHandler: () => Promise.resolve(undefined),
            })

            const configParams = {
                section: 'aws.testconfig',
                settings: {
                    testSetting: 'value',
                },
            }

            lspRouter.servers = [server1, server2]
            const result = await lspRouter.updateConfiguration(configParams, {} as CancellationToken)

            assert.strictEqual(result, null)
        })

        it('should return ResponseError if at least one server returned an error', async () => {
            const error = new ResponseError(111, 'Configuration update failed')
            const server1 = newServer({
                updateConfigurationHandler: () => Promise.resolve(null),
            })
            const server2 = newServer({
                updateConfigurationHandler: () => Promise.reject(error),
            })

            const configParams = {
                section: 'aws.testconfig',
                settings: {
                    testSetting: 'value',
                },
            }

            lspRouter.servers = [server1, server2]

            try {
                await lspRouter.updateConfiguration(configParams, {} as CancellationToken)
                assert.fail('Expected error to be thrown')
            } catch (err) {
                assert(err instanceof ResponseError)
                assert.equal(err.code, 111)
                assert.equal(err.message, 'Configuration update failed')
            }
        })
    })

    describe('didChangeWorkspaceFolders', () => {
        it('should update workspace folders and route notification to servers', () => {
            const initialFolders = [
                { name: 'initial', uri: 'file:///initial' },
                { name: 'toRemove', uri: 'file:///toRemove' },
            ]
            lspRouter['workspaceFolders'] = initialFolders

            lspRouter.clientInitializeParams = {
                capabilities: {
                    workspace: {
                        workspaceFolders: true,
                    },
                },
            } as InitializeParams

            const didChangeWorkspaceFoldersSpy = sandbox.spy()
            const server = newServer({
                didChangeWorkspaceFoldersHandler: didChangeWorkspaceFoldersSpy,
            })
            lspRouter.servers = [server]

            const event = {
                added: [{ name: 'added', uri: 'file:///added' }],
                removed: [{ name: 'toRemove', uri: 'file:///toRemove' }],
            }

            lspRouter.didChangeWorkspaceFolders(event)

            const expectedFolders = [
                { name: 'initial', uri: 'file:///initial' },
                { name: 'added', uri: 'file:///added' },
            ]
            assert.deepStrictEqual(lspRouter.getAllWorkspaceFolders(), expectedFolders)
            assert(didChangeWorkspaceFoldersSpy.calledWith({ event }))
        })

        it('should filter out duplicate workspace folder URIs when adding', () => {
            const initialFolders = [
                { name: 'existing', uri: 'file:///existing' },
                { name: 'another', uri: 'file:///another' },
            ]
            lspRouter['workspaceFolders'] = initialFolders

            const event = {
                added: [
                    { name: 'new', uri: 'file:///new' },
                    { name: 'duplicate', uri: 'file:///existing' }, // duplicate URI
                    { name: 'duplicate', uri: 'file:///existing/' }, // duplicate URI with /
                ],
                removed: [],
            }

            lspRouter.didChangeWorkspaceFolders(event)

            const expectedFolders = [
                { name: 'existing', uri: 'file:///existing' },
                { name: 'another', uri: 'file:///another' },
                { name: 'new', uri: 'file:///new' },
            ]
            assert.deepStrictEqual(lspRouter.getAllWorkspaceFolders(), expectedFolders)
        })
    })

    describe('didCreateFiles', () => {
        it('should route didCreateFiles notifications to single server', () => {
            const didCreateFilesSpy = sandbox.spy()
            const server = newServer({
                didCreateFilesHandler: didCreateFilesSpy,
            })
            lspRouter.servers = [server]

            const params: CreateFilesParams = {
                files: [{ uri: 'file:///test/file.txt' }],
            }

            lspRouter.didCreateFiles(params)

            assert(didCreateFilesSpy.calledWith(params))
        })

        it('should route didCreateFiles notifications to multiple servers', () => {
            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const spy3 = sandbox.spy()

            const server1 = newServer({ didCreateFilesHandler: spy1 })
            const server2 = newServer({ didCreateFilesHandler: spy2 })
            const server3 = newServer({ didCreateFilesHandler: spy3 })

            lspRouter.servers = [server1, server2, server3]

            const params: CreateFilesParams = {
                files: [{ uri: 'file:///test/file.txt' }],
            }

            lspRouter.didCreateFiles(params)

            assert(spy1.calledWith(params))
            assert(spy2.calledWith(params))
            assert(spy3.calledWith(params))
        })
    })

    describe('didDeleteFiles', () => {
        it('should route didDeleteFiles notifications to single server', () => {
            const didDeleteFilesSpy = sandbox.spy()
            const server = newServer({
                didDeleteFilesHandler: didDeleteFilesSpy,
            })
            lspRouter.servers = [server]

            const params: DeleteFilesParams = {
                files: [{ uri: 'file:///test/file.txt' }],
            }

            lspRouter.didDeleteFiles(params)

            assert(didDeleteFilesSpy.calledWith(params))
        })

        it('should route didDeleteFiles notifications to multiple servers', () => {
            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const spy3 = sandbox.spy()

            const server1 = newServer({ didDeleteFilesHandler: spy1 })
            const server2 = newServer({ didDeleteFilesHandler: spy2 })
            const server3 = newServer({ didDeleteFilesHandler: spy3 })

            lspRouter.servers = [server1, server2, server3]

            const params: DeleteFilesParams = {
                files: [{ uri: 'file:///test/file.txt' }],
            }

            lspRouter.didDeleteFiles(params)

            assert(spy1.calledWith(params))
            assert(spy2.calledWith(params))
            assert(spy3.calledWith(params))
        })
    })

    describe('didRenameFiles', () => {
        it('should route didRenameFiles notifications to single server', () => {
            const didRenameFilesSpy = sandbox.spy()
            const server = newServer({
                didRenameFilesHandler: didRenameFilesSpy,
            })
            lspRouter.servers = [server]

            const params: RenameFilesParams = {
                files: [
                    {
                        oldUri: 'file:///test/oldfile.txt',
                        newUri: 'file:///test/newfile.txt',
                    },
                ],
            }

            lspRouter.didRenameFiles(params)

            assert(didRenameFilesSpy.calledWith(params))
        })

        it('should route didRenameFiles notifications to multiple servers', () => {
            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const spy3 = sandbox.spy()

            const server1 = newServer({ didRenameFilesHandler: spy1 })
            const server2 = newServer({ didRenameFilesHandler: spy2 })
            const server3 = newServer({ didRenameFilesHandler: spy3 })

            lspRouter.servers = [server1, server2, server3]

            const params: RenameFilesParams = {
                files: [
                    {
                        oldUri: 'file:///test/oldfile.txt',
                        newUri: 'file:///test/newfile.txt',
                    },
                ],
            }

            lspRouter.didRenameFiles(params)

            assert(spy1.calledWith(params))
            assert(spy2.calledWith(params))
            assert(spy3.calledWith(params))
        })
    })

    describe('didSaveTextDocument', () => {
        it('should route didSaveTextDocument notifications to single server', () => {
            const didSaveTextDocumentSpy = sandbox.spy()
            const server = newServer({
                didSaveTextDocumentHandler: didSaveTextDocumentSpy,
            })
            lspRouter.servers = [server]

            const params: DidSaveTextDocumentParams = {
                textDocument: { uri: 'file:///test/file.txt' },
            }

            lspRouter.didSaveTextDocument(params)

            assert(didSaveTextDocumentSpy.calledWith(params))
        })

        it('should route didSaveTextDocument notifications to multiple servers', () => {
            const spy1 = sandbox.spy()
            const spy2 = sandbox.spy()
            const spy3 = sandbox.spy()

            const server1 = newServer({ didSaveTextDocumentHandler: spy1 })
            const server2 = newServer({ didSaveTextDocumentHandler: spy2 })
            const server3 = newServer({ didSaveTextDocumentHandler: spy3 })

            lspRouter.servers = [server1, server2, server3]

            const params: DidSaveTextDocumentParams = {
                textDocument: { uri: 'file:///test/file.txt' },
            }

            lspRouter.didSaveTextDocument(params)

            assert(spy1.calledWith(params))
            assert(spy2.calledWith(params))
            assert(spy3.calledWith(params))
        })
    })

    describe('notifications', () => {
        const initHandler = () => {
            return {
                serverInfo: {
                    name: 'Notification Server',
                },
            }
        }
        const initParam = {
            initializationOptions: {
                aws: {
                    awsClientCapabilities: {
                        window: {
                            notifications: true,
                        },
                    },
                },
            },
        }
        const notificationParams: NotificationParams = {
            id: 'id-1',
            type: MessageType.Info,
            content: {
                text: 'Update happened',
            },
        }

        it('should send notification if notifications are supported and server name is defined', async () => {
            const notificationSpy = sandbox.spy()
            const lspConn = stubLspConnection({ sendNotification: notificationSpy })

            const server = newServer({ lspConnection: lspConn, initializeHandler: initHandler })
            await server.initialize(initParam as InitializeParams, {} as CancellationToken)

            server.notification.showNotification(notificationParams)

            assert(notificationSpy.calledOnce)
        })

        it('should not send notification if server name is not defined', async () => {
            const notificationSpy = sandbox.spy()
            const lspConn = stubLspConnection({ sendNotification: notificationSpy })

            const server = newServer({
                lspConnection: lspConn,
                initializeHandler: () => {
                    // no server name defined
                },
            })
            await server.initialize(initParam as InitializeParams, {} as CancellationToken)

            server.notification.showNotification(notificationParams)

            assert(notificationSpy.notCalled)
        })

        it('should not send notification if not supported by client', async () => {
            const notificationSpy = sandbox.spy()
            const lspConn = stubLspConnection({ sendNotification: notificationSpy })

            const server = newServer({ lspConnection: lspConn, initializeHandler: initHandler })
            await server.initialize({} as InitializeParams, {} as CancellationToken)

            server.notification.showNotification(notificationParams)

            assert(notificationSpy.notCalled)
        })

        it('should send followup to source server by matching server name in id', async () => {
            const lspConn = stubLspConnection()

            const server = newServer({ lspConnection: lspConn, initializeHandler: initHandler })
            await server.initialize(initParam as InitializeParams, {} as CancellationToken)
            lspRouter.servers = [server]

            const notificationFollowupSpy = sandbox.spy()
            server.notification.onNotificationFollowup(notificationFollowupSpy)

            const notificationFollowup: NotificationFollowupParams = {
                source: {
                    id: '{"serverName":"Notification Server", "id":"1"}',
                },
                action: 'Acknowledge',
            }
            lspRouter.onNotificationFollowup(notificationFollowup)

            assert(notificationFollowupSpy.calledOnce)
        })
    })

    function stubLspConnection(overrides = {}): Connection {
        return {
            console: {
                info: (message: any) => {},
            },
            telemetry: {
                logEvent: (message: any) => {},
            },
            workspace: {
                onDidCreateFiles: (handler: any) => {},
                onDidDeleteFiles: (handler: any) => {},
                onDidRenameFiles: (handler: any) => {},
                onDidChangeWorkspaceFolders: (handler: any) => {},
            },
            onDidSaveTextDocument: (handler: any) => {},
            onInitialize: (handler: any) => {},
            onInitialized: (handler: any) => {},
            onExecuteCommand: (handler: any) => {},
            onRequest: (handler: any) => {},
            onNotification: (handler: any) => {},
            onDidChangeConfiguration: (handler: any) => {},
            ...overrides,
        } as Connection
    }

    function newServer({
        lspConnection,
        didChangeConfigurationHandler,
        executeCommandHandler,
        getServerConfigurationHandler,
        initializeHandler,
        initializedHandler,
        updateConfigurationHandler,
        credentialsDeleteHandler,
        didChangeWorkspaceFoldersHandler,
        didCreateFilesHandler,
        didDeleteFilesHandler,
        didRenameFilesHandler,
        didSaveTextDocumentHandler,
    }: {
        lspConnection?: Connection
        didChangeConfigurationHandler?: any
        executeCommandHandler?: any
        getServerConfigurationHandler?: any
        initializeHandler?: any
        initializedHandler?: any
        updateConfigurationHandler?: any
        credentialsDeleteHandler?: any
        didChangeWorkspaceFoldersHandler?: any
        didCreateFilesHandler?: any
        didDeleteFilesHandler?: any
        didRenameFilesHandler?: any
        didSaveTextDocumentHandler?: any
    }) {
        const server = new LspServer(lspConnection || stubLspConnection(), encoding, logging)
        server.setDidChangeConfigurationHandler(didChangeConfigurationHandler)
        server.setExecuteCommandHandler(executeCommandHandler)
        server.setServerConfigurationHandler(getServerConfigurationHandler)
        server.setInitializeHandler(initializeHandler)
        server.setInitializedHandler(initializedHandler)
        server.setUpdateConfigurationHandler(updateConfigurationHandler)
        server.setCredentialsDeleteHandler(credentialsDeleteHandler)
        server.setDidChangeWorkspaceFoldersHandler(didChangeWorkspaceFoldersHandler)
        server.setDidCreateFilesHandler(didCreateFilesHandler)
        server.setDidDeleteFilesHandler(didDeleteFilesHandler)
        server.setDidRenameFilesHandler(didRenameFilesHandler)
        server.setDidSaveTextDocumentHandler(didSaveTextDocumentHandler)
        return server
    }
})
