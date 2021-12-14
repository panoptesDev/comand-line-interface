import Listr from 'listr'
import execa from 'execa'
import chalk from 'chalk'
import path from 'path'
import fs from 'fs-extra'

import { loadConfig } from '../config'
import { cloneRepository, getKeystoreFile, processTemplateFiles } from '../../lib/utils'
import { printDependencyInstructions, getDefaultBranch } from '../helper'
import { Genesis } from '../genesis'

// default password
export const KEYSTORE_PASSWORD = 'hello'

//
// Pano setup class
//

export class Pano {
  constructor(config, options = {}) {
    this.config = config

    this.repositoryName = 'pano'
    this.repositoryBranch = options.repositoryBranch || 'master'
    this.repositoryUrl = options.repositoryUrl || 'https://github.com/panoprotocol/pano'

    this.genesis = new Genesis(config)
  }

  get name() {
    return 'pano'
  }

  get taskTitle() {
    return 'Setup Pano'
  }

  get repositoryDir() {
    return path.join(this.config.codeDir, this.repositoryName)
  }

  get buildDir() {
    return path.join(this.repositoryDir, 'build')
  }

  get panoDataDir() {
    return path.join(this.config.dataDir, 'pano')
  }

  get keystoreDir() {
    return path.join(this.config.dataDir, 'keystore')
  }

  get passwordFilePath() {
    return path.join(this.config.dataDir, 'password.txt')
  }

  get keystorePassword() {
    return this.config.keystorePassword || KEYSTORE_PASSWORD
  }

  async print() {
    console.log(chalk.gray('Pano data') + ': ' + chalk.bold.green(this.panoDataDir))
    console.log(chalk.gray('Pano repo') + ': ' + chalk.bold.green(this.repositoryDir))
    console.log(chalk.gray('Setup pano chain') + ': ' + chalk.bold.green('bash pano-setup.sh'))
    console.log(chalk.gray('Start pano chain') + ': ' + chalk.bold.green('bash pano-start.sh'))
    console.log(chalk.gray('Clean pano chain') + ': ' + chalk.bold.green('bash pano-clean.sh'))
    console.log(chalk.gray('config.dataDir') + ': ' + chalk.bold.green(this.config.dataDir))
  }

  async getTasks() {
    return new Listr(
      [
        {
          title: 'Clone Pano repository',
          task: () => cloneRepository(this.repositoryName, this.repositoryBranch, this.repositoryUrl, this.config.codeDir)
        },
        {
          title: 'Build Pano',
          task: () => execa('make', ['pano-all'], {
            cwd: this.repositoryDir
          })
        },
        {
          title: 'Prepare data directory',
          task: () => {
            return execa('mkdir', ['-p', this.config.dataDir, this.panoDataDir, this.keystoreDir], {
              cwd: this.config.targetDirectory
            })
          }
        },
        {
          title: 'Prepare keystore and password.txt',
          task: () => {
            // get keystore file and store in keystore file
            const keystoreFileObj = getKeystoreFile(this.config.primaryAccount.privateKey, this.config.keystorePassword)

            // resolve promise
            return fs.emptyDir(this.keystoreDir).then(() => {
              const p = [
                fs.writeFile(this.passwordFilePath, `${this.config.keystorePassword}\n`),
                fs.writeFile(path.join(this.keystoreDir, keystoreFileObj.keystoreFilename), JSON.stringify(keystoreFileObj.keystore, null, 2))
              ]
              return Promise.all(p)
            })
          }
        },
        {
          title: 'Process template scripts',
          task: async () => {
            const templateDir = path.resolve(
              new URL(import.meta.url).pathname,
              '../templates'
            )

            // copy all templates to target directory
            await fs.copy(templateDir, this.config.targetDirectory)

            // process all njk templates
            await processTemplateFiles(this.config.targetDirectory, { obj: this })
          }
        }
      ],
      {
        exitOnError: true
      }
    )
  }
}

async function setupPano(config) {
  const pano = new Pano(config)

  const tasks = new Listr(
    [
      {
        title: pano.genesis.taskTitle,
        task: () => {
          return pano.genesis.getTasks()
        }
      },
      {
        title: pano.taskTitle,
        task: () => {
          return pano.getTasks()
        }
      }
    ],
    {
      exitOnError: true
    }
  )

  await tasks.run()
  console.log('%s Pano is ready', chalk.green.bold('DONE'))

  // print config
  await config.print()
  await pano.genesis.print(config)
  await pano.print()

  return true
}

export default async function () {
  await printDependencyInstructions()

  // configuration
  const config = await loadConfig({ targetDirectory: process.cwd() })
  await config.loadChainIds()
  await config.loadAccounts()

  // load branch
  const answers = await getDefaultBranch(config)
  config.set(answers)

  // start setup
  await setupPano(config)
}
