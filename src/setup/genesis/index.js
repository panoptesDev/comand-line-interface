import Listr from 'listr'
import execa from 'execa'
import chalk from 'chalk'
import inquirer from 'inquirer'
import path from 'path'
import fs from 'fs'
import { projectInstall } from 'pkg-install'
import { isValidAddress } from 'ethereumjs-util'

import { loadConfig } from '../config'
import { cloneRepository } from '../../lib/utils'
import { printDependencyInstructions } from '../helper'

// balance
const DEFAULT_BALANCE = 300000000

export class Genesis {
  constructor(config, options = {}) {
    this.config = config

    this.repositoryName = this.name
    this.repositoryBranch ='master'
    this.repositoryUrl = options.repositoryUrl || 'https://github.com/panoprotocol/genesis-contracts'
    this.panoContractsRepository = 'pano-contracts'
    this.panoContractsRepositoryUrl = 'https://github.com/panoprotocol/contracts.git'
    this.panoContractsRepositoryBranch = config.contractsBranch || 'stake'

  }

  get name() {
    return 'genesis-contracts'
  }

  get taskTitle() {
    return 'Setup genesis contracts'
  }

  get repositoryDir() {
    return path.join(this.config.codeDir, this.repositoryName)
  }

  get panoContractsDir() {
    return path.join(this.config.codeDir, this.repositoryName, this.panoContractsRepository)
  }

  get panoGenesisFilePath() {
    return path.join(this.repositoryDir, 'genesis.json')
  }

  async print() {
    console.log(chalk.gray('Pano genesis path') + ': ' + chalk.bold.green(this.panoGenesisFilePath))
  }

  // get genesis contact tasks
  async getTasks() {
    return new Listr(
      [
        {
          title: 'Clone genesis-contracts repository',
          task: () => cloneRepository(this.repositoryName, this.repositoryBranch, this.repositoryUrl, this.config.codeDir)
        },

        {
          title: 'Install dependencies for genesis-contracts',
          task: () => projectInstall({
            cwd: this.repositoryDir
          })
        },
        {
          title: 'Setting up sub-modules',
          task: () => execa('git', ['submodule', 'init'], {
            cwd: this.repositoryDir
          })
        },
        {
          title: 'Update sub-modules',
          task: () => execa('git', ['submodule', 'update'], {
            cwd: this.repositoryDir
          })
        },
        {
          title: 'change pano-contracts branch',
          task: () => execa('git', ['checkout', this.panoContractsRepositoryBranch], {
            cwd: this.panoContractsDir
          })
        },
        {
          title: 'Install dependencies for pano-contracts',
          task: () => projectInstall({
            cwd: this.panoContractsDir
          })
        },
        {
          title: 'Process templates',
          task: () => execa('npm', ['run', 'template:process', '--', '--pano-chain-id', this.config.panoChainId], {
            cwd: this.panoContractsDir
          })
        },
        {
          title: 'Prepare validators for genesis file',
          task: () => {
            const validators = this.config.genesisAddresses.map(a => {
              return {
                address: a,
                stake: this.config.defaultStake, // without 10^18
                balance: DEFAULT_BALANCE // without 10^18
              }
            })

            return Promise.resolve().then(() => {
              // check if validators js exists
              const validatorJsPath = path.join(this.repositoryDir, 'validators.js')
              if (!fs.existsSync(validatorJsPath)) {
                return
              }

              // take validator js backup
              return execa('mv', ['validators.js', 'validators.js.backup'], {
                cwd: this.repositoryDir
              })
            }).then(() => {
              fs.writeFileSync(path.join(this.repositoryDir, 'validators.json'), JSON.stringify(validators, null, 2), 'utf8')
            })
          }
        },
        {
          title: 'Generate pano validator set',
          task: () => execa('node', [
            'generate-borvalidatorset.js', '--pano-chain-id', this.config.panoChainId, '--delivery-chain-id', this.config.deliveryChainId
          ], {
            cwd: this.repositoryDir
          })
        },
        {
          title: 'Generate genesis.json',
          task: () => execa('node', [
            'generate-genesis.js', '--pano-chain-id', this.config.panoChainId, '--delivery-chain-id', this.config.deliveryChainId
          ], {
            cwd: this.repositoryDir
          })
        }
      ],
      {
        exitOnError: true
      }
    )
  }
}

export async function getGenesisAddresses() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'genesisAddresses',
      message: 'Please enter comma separated validator addresses',
      default: '0xfA841eAAcf03598bAadF0266eF6097C654DE5465',
      validate: (input) => {
        const addrs = input.split(',').map(a => {
          return a.trim().toLowerCase()
        }).filter(a => {
          return isValidAddress(a)
        })

        // check if addrs has any valid address
        if (addrs.length === 0) {
          return 'Enter valid addresses (comma separated)'
        }

        return true
      }
    }
  ])

  // set genesis addresses
  return answers.genesisAddresses.split(',').map(a => {
    return a.trim().toLowerCase()
  })
}

async function setupGenesis(config) {
  const genesis = new Genesis(config)

  // load genesis addresses
  config.genesisAddresses = await getGenesisAddresses()

  // get all genesis related tasks
  const tasks = await genesis.getTasks()

  // run all tasks
  await tasks.run()
  console.log('%s Genesis file is ready', chalk.green.bold('DONE'))

  // print genesis path
  await genesis.print()

  return true
}

export default async function () {
  await printDependencyInstructions()

  // configuration
  const config = await loadConfig()
  await config.loadChainIds()

  // start setup
  await setupGenesis(config)
}
