import { createClient, type ClickHouseClientConfigOptions } from '@clickhouse/client';
import {
  Logger,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
} from '@nestjs/common';
import { getClickHouseToken } from './clickhouse.tokens.js';

export interface ClickHouseModuleOptions extends ClickHouseClientConfigOptions {
  name?: string;
  global?: boolean;
}

export interface ClickHouseModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  name?: string;
  global?: boolean;
  inject?: InjectionToken[];
  useFactory: (
    ...args: any[]
  ) => ClickHouseClientConfigOptions | Promise<ClickHouseClientConfigOptions>;
}

@Module({})
export class ClickHouseModule {
  static forRoot(options: ClickHouseModuleOptions): DynamicModule {
    const {
      name,
      global = true,
      ...clientOptions
    } = options;

    return this.createDynamicModule(
      getClickHouseToken(name),
      global,
      [],
      [],
      () => clientOptions,
    );
  }

  static forRootAsync(options: ClickHouseModuleAsyncOptions): DynamicModule {
    return this.createDynamicModule(
      getClickHouseToken(options.name),
      options.global ?? true,
      options.imports ?? [],
      options.inject ?? [],
      options.useFactory,
    );
  }

  private static createDynamicModule(
    clientToken: InjectionToken,
    global: boolean,
    imports: ModuleMetadata['imports'],
    inject: InjectionToken[],
    useFactory: (...args: any[]) =>
      | ClickHouseClientConfigOptions
      | Promise<ClickHouseClientConfigOptions>,
  ): DynamicModule {
    const lifecycleToken = Symbol('CLICKHOUSE_CLIENT_LIFECYCLE');

    return {
      module: ClickHouseModule,
      global,
      imports,
      providers: [
        {
          provide: clientToken,
          inject,
          useFactory: async (...args: any[]) => createClient(await useFactory(...args)),
        },
        {
          provide: lifecycleToken,
          inject: [clientToken],
          useFactory: (client: ReturnType<typeof createClient>) => ({
            async onApplicationShutdown() {
              await client.close();
              new Logger(ClickHouseModule.name).log('ClickHouse client closed');
            },
          }),
        },
      ],
      exports: [clientToken],
    };
  }
}
